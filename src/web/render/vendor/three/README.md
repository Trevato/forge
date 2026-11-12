# three.js, vendored

[three.js](https://threejs.org) **0.186.1**, from the npm package `three@0.186.1`,
MIT licensed (`LICENSE`, beside this file). It draws the blob page's 3D view
(`src/web/render/model3d-client.ts`) and nothing else: it is bundled into
`/assets/model3d-<hash>.js`, which the shell loads only on a page that shows
a model. No CDN, no remote script, no runtime dependency.

Why a library at all: a WebGL renderer, orbit controls and a glTF loader are
thousands of lines each to write and to get right. STL and OBJ are parsed by
`src/web/render/mesh.ts`, our own, since they are simple and tested.

The files are upstream's, byte for byte, at upstream's own paths; they import
`three`, which `model3d.ts` resolves to `build/three.module.js` when it
bundles. `three.d.ts` (one level up) types the slice the viewer uses. To
upgrade, copy the same files from the new package, check the hashes it
prints, and update this list:

```
8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc  ./LICENSE
9edde002b066a9a05676a6127f67735b62baf399bdea529f2f7e31657da769e6  ./build/three.core.js
9052042d676cb0fdc1ddfefe193053f34b7ac0513a616fdac4535d49987812ea  ./build/three.module.js
3d79d07ecb686b4e5d93232eedab255331c1beef711e13164eaa1f68655a5f2b  ./examples/jsm/controls/OrbitControls.js
131c0f78c01d19368ae495caa65b3adaa10487810a36a05bb5901b769a35ac16  ./examples/jsm/loaders/GLTFLoader.js
9fb63427ce6641fa14fd0baff9cc4d1b5f9c3d85fd084bf2e90e803c44ec1797  ./examples/jsm/utils/BufferGeometryUtils.js
b1632a703206c3d830de9fcbe515696770d04b71a15ee6b50afa6d2c3298c86f  ./examples/jsm/utils/SkeletonUtils.js
```
