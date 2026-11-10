/**
 * The slice of three.js (vendored beside this file, see README.md) the 3D
 * viewer uses, typed by hand so the checker sees it without `@types/three`.
 * Page elements are `object`: the checker runs without the DOM library,
 * which would retype the server. `model3d.ts` maps these module names onto
 * the vendored files when it bundles the viewer; nothing on the server
 * imports them.
 */

declare module "three" {
  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
    copy(v: Vector3): this;
    add(v: Vector3): this;
    multiplyScalar(s: number): this;
    normalize(): this;
    length(): number;
  }
  export class Color {
    constructor(color: string | number);
  }
  export class Box3 {
    min: Vector3;
    max: Vector3;
    setFromObject(object: Object3D): this;
    getSize(target: Vector3): Vector3;
    getCenter(target: Vector3): Vector3;
  }
  export class Object3D {
    position: Vector3;
    rotation: { x: number; y: number; z: number };
    visible: boolean;
    add(...objects: Object3D[]): this;
    traverse(callback: (object: Object3D) => void): void;
    updateMatrixWorld(force?: boolean): void;
  }
  export class Scene extends Object3D {}
  export class Group extends Object3D {}
  export class Material {
    wireframe: boolean;
    transparent: boolean;
    opacity: number;
  }
  export class MeshStandardMaterial extends Material {
    constructor(parameters?: {
      color?: Color | string | number;
      roughness?: number;
      metalness?: number;
      flatShading?: boolean;
      side?: number;
    });
  }
  export const DoubleSide: number;
  export class BufferAttribute {
    count: number;
  }
  export class Float32BufferAttribute extends BufferAttribute {
    constructor(array: Float32Array, itemSize: number);
  }
  export class BufferGeometry {
    index: BufferAttribute | null;
    setAttribute(name: string, attribute: BufferAttribute): this;
    getAttribute(name: string): BufferAttribute | undefined;
    computeVertexNormals(): void;
  }
  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
    geometry: BufferGeometry;
    material: Material | Material[];
  }
  export class PerspectiveCamera extends Object3D {
    constructor(fov: number, aspect: number, near: number, far: number);
    fov: number;
    aspect: number;
    updateProjectionMatrix(): void;
  }
  export class HemisphereLight extends Object3D {
    constructor(sky: number, ground: number, intensity: number);
  }
  export class DirectionalLight extends Object3D {
    constructor(color: number, intensity: number);
  }
  export class GridHelper extends Object3D {
    constructor(size: number, divisions: number, center: Color, grid: Color);
    material: Material;
  }
  export class AxesHelper extends Object3D {
    constructor(size: number);
  }
  export class LoadingManager {
    setURLModifier(transform: (url: string) => string): this;
  }
  export class WebGLRenderer {
    constructor(parameters: { canvas: object; antialias?: boolean; alpha?: boolean });
    setPixelRatio(ratio: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    render(scene: Object3D, camera: PerspectiveCamera): void;
    dispose(): void;
    forceContextLoss(): void;
  }
}

declare module "three/addons/controls/OrbitControls.js" {
  import type { PerspectiveCamera, Vector3 } from "three";
  export class OrbitControls {
    constructor(camera: PerspectiveCamera, element: object);
    target: Vector3;
    update(): boolean;
    listenToKeyEvents(element: object): void;
    addEventListener(type: "change", listener: () => void): void;
    dispose(): void;
  }
}

declare module "three/addons/loaders/GLTFLoader.js" {
  import type { Group, LoadingManager } from "three";
  export class GLTFLoader {
    constructor(manager?: LoadingManager);
    parse(
      data: ArrayBuffer | string,
      path: string,
      onLoad: (gltf: { scene: Group }) => void,
      onError: (error: unknown) => void,
    ): void;
  }
}
