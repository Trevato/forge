/**
 * The 3D viewer, in the browser. `model3d.ts` bundles this file with the
 * vendored three.js into `/assets/model3d-<hash>.js`, and the shell loads it
 * only when a page carries a `.model3d` figure, so no other page pays for it.
 *
 * Each figure names its file's media-route address (`data-src`) and format
 * (`data-format`). The bytes are fetched and parsed here, on the reader's
 * machine; the server never parses a model. A figure this cannot draw — no
 * WebGL, a fetch that fails, bytes that are not the format — keeps the
 * server-rendered note with its Download button, and its header says why.
 *
 * Drawing is on demand, never a loop: a frame is rendered when the camera
 * moves, the stage resizes or a toggle flips.
 */

import {
  AxesHelper,
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  GridHelper,
  HemisphereLight,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { REFUSED_URI, withinModelDir } from "./gltf-uri.ts";
import { parse3mf } from "./threemf.ts";
import { bounds, parseObj, parseStl, sizeText, type Bounds } from "./mesh.ts";

/**
 * The little of the DOM this touches. The checker runs without the DOM
 * library, which would retype the whole server, so it is named here.
 */
interface Element {
  readonly dataset: Record<string, string | undefined>;
  readonly isConnected: boolean;
  textContent: string | null;
  hidden: boolean;
  tabIndex: number;
  readonly value?: string;
  querySelector(selector: string): Element | null;
  querySelectorAll(selector: string): Iterable<Element>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
  replaceChildren(...nodes: Element[]): void;
  getBoundingClientRect(): { width: number; height: number };
}
interface Browser {
  readonly document: Element & { createElement(tag: string): Element };
  readonly devicePixelRatio: number;
  readonly location: { readonly href: string };
  getComputedStyle(element: Element): { color: string };
  ResizeObserver: new (callback: () => void) => { observe(element: Element): void; disconnect(): void };
}
const { document, devicePixelRatio, location, getComputedStyle, ResizeObserver } = globalThis as unknown as Browser;

interface Loaded {
  readonly object: Object3D;
  readonly triangles: number;
  /** In the file's own axes and the unit below. */
  readonly box: Bounds;
}

interface Viewer {
  readonly figure: Element;
  dispose(): void;
}

const live: Viewer[] = [];

/** A part reads best in one flat, neutral colour, lit from where you stand. */
const material = (): MeshStandardMaterial =>
  new MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.7, metalness: 0.05, flatShading: true, side: DoubleSide });

function soup(positions: Float32Array): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return new Mesh(geometry, material());
}

async function load(src: string, format: string): Promise<Loaded> {
  const response = await fetch(src, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`the file answered ${response.status}`);
  if (format === "stl" || format === "obj" || format === "3mf") {
    const parsed =
      format === "obj"
        ? parseObj(await response.text())
        : format === "3mf"
          ? await parse3mf(new Uint8Array(await response.arrayBuffer()))
          : parseStl(new Uint8Array(await response.arrayBuffer()));
    const mesh = soup(parsed.positions);
    // A printed part is modelled Z-up; three.js stands Y-up.
    if (format === "stl" || format === "3mf") mesh.rotation.x = -Math.PI / 2;
    return { object: mesh, triangles: parsed.triangles, box: bounds(parsed.positions) };
  }
  // glTF: binary, or JSON whose buffers sit beside it on the media route.
  const data = format === "glb" ? await response.arrayBuffer() : await response.text();
  const base = src.slice(0, src.lastIndexOf("/") + 1);
  // The file names its buffers and images; only those beside it are fetched.
  const manager = new LoadingManager().setURLModifier((url) =>
    withinModelDir(url, base, location.href) ? url : REFUSED_URI,
  );
  const gltf = await new Promise<{ scene: Object3D }>((resolve, reject) =>
    new GLTFLoader(manager).parse(data, base, resolve, reject),
  );
  let triangles = 0;
  gltf.scene.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    const geometry = node.geometry;
    triangles += Math.floor((geometry.index ?? geometry.getAttribute("position"))!.count / 3);
    node.material = material();
  });
  const box = new Box3().setFromObject(gltf.scene);
  // glTF is in metres by its spec; the header speaks millimetres.
  const mm = (v: Vector3): [number, number, number] => [v.x * 1000, v.y * 1000, v.z * 1000];
  const min = mm(box.min);
  const max = mm(box.max);
  return {
    object: gltf.scene,
    triangles,
    box: { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] },
  };
}

/** A round grid step: 1, 2 or 5 times a power of ten. */
function niceStep(span: number): number {
  const raw = span / 10;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

function mount(figure: Element): void {
  if (figure.dataset.mounted !== undefined) return;
  figure.dataset.mounted = "";
  const stage = figure.querySelector("[data-stage]");
  const stats = figure.querySelector("[data-stats]");
  const tools = figure.querySelector("[data-tools]");
  const src = figure.dataset.src;
  const format = figure.dataset.format ?? "";
  if (stage === null || stats === null || tools === null || src === undefined) return;

  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", figure.dataset.label ?? "3D view");
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    // No WebGL here: the note and its Download button stay as served.
    return;
  }
  // The note speaks for a page that cannot draw; this one can, until the
  // file says otherwise.
  const note = stage.querySelector(".empty");
  if (note !== null) note.hidden = true;
  stats.textContent = "Loading…";
  const fact = (selector: string, value: string): void => {
    const row = figure.querySelector(selector);
    const cell = row?.querySelector("dd");
    if (row === null || row === undefined || cell === null || cell === undefined) return;
    cell.textContent = value;
    row.hidden = false;
  };

  load(src, format).then(
    ({ object, triangles, box }) => {
      if (!figure.isConnected) return renderer.dispose();
      const scene = new Scene();
      scene.add(object);
      // Stand the part on the grid, centred under the camera.
      object.updateMatrixWorld(true);
      const fit = new Box3().setFromObject(object);
      const size = fit.getSize(new Vector3());
      const centre = fit.getCenter(new Vector3());
      object.position.set(-centre.x, -fit.min.y, -centre.z);
      const span = Math.max(size.x, size.y, size.z) || 1;

      const ink = new Color(getComputedStyle(figure).color);
      const step = niceStep(span * 2);
      const extent = Math.ceil((span * 2) / step) * step;
      const grid = new GridHelper(extent, Math.round(extent / step), ink, ink);
      grid.material.transparent = true;
      grid.material.opacity = 0.2;
      // Just under the part, so its bottom face never flickers with the grid.
      grid.position.y = -span / 1000;
      const axes = new AxesHelper(span * 0.75);
      axes.visible = false;
      scene.add(grid, axes, new HemisphereLight(0xffffff, 0x666666, 1.6));

      const camera = new PerspectiveCamera(40, 1, span / 100, span * 100);
      const light = new DirectionalLight(0xffffff, 1.4);
      light.position.set(1, 2, 3);
      camera.add(light);
      scene.add(camera);
      const target = new Vector3(0, size.y / 2, 0);
      const radius = size.length() / 2 || span;
      const distance = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.1;
      camera.position.copy(target).add(new Vector3(1, 0.8, 1.2).normalize().multiplyScalar(distance));

      const controls = new OrbitControls(camera, canvas);
      controls.target.copy(target);
      controls.listenToKeyEvents(canvas);
      const draw = (): void => renderer.render(scene, camera);
      controls.addEventListener("change", draw);
      controls.update();

      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      const resize = (): void => {
        const { width, height } = stage.getBoundingClientRect();
        if (width === 0 || height === 0) return;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        draw();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(stage);
      stage.replaceChildren(canvas);
      resize();

      stats.textContent = "";
      fact("[data-triangles]", triangles.toLocaleString("en"));
      fact("[data-box]", sizeText(box.size));
      for (const button of tools.querySelectorAll("button[value]")) {
        button.addEventListener("click", () => {
          const on = button.getAttribute("aria-pressed") !== "true";
          button.setAttribute("aria-pressed", String(on));
          if (button.value === "axes") axes.visible = on;
          else
            object.traverse((node) => {
              if (node instanceof Mesh)
                for (const m of [node.material].flat()) m.wireframe = on;
            });
          draw();
        });
      }
      tools.hidden = false;
      live.push({
        figure,
        dispose() {
          observer.disconnect();
          controls.dispose();
          renderer.dispose();
          renderer.forceContextLoss();
        },
      });
    },
    (error: unknown) => {
      renderer.dispose();
      if (note !== null) note.hidden = false;
      stats.textContent = `Could not draw this file: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
}

/** Mount every figure on the page, and let go of any a swap took away. */
function mountAll(): void {
  for (let i = live.length - 1; i >= 0; i--)
    if (!live[i]!.figure.isConnected) live.splice(i, 1)[0]!.dispose();
  for (const figure of document.querySelectorAll(".model3d[data-src]")) mount(figure);
}

mountAll();
// The code browser swaps files in place (`client.ts`); a module runs once.
document.addEventListener("code:swap", mountAll);
