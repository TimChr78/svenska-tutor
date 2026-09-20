// VRM avatar (three-vrm): renders the tutor, driven by tutor audio energy.
// Falls back silently to the pulsing ring when WebGL/VRM/model unavailable.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let vrm: VRM | null = null;
let mouthMesh: THREE.Mesh | null = null;
let raf = 0;
let clock = new THREE.Clock();

export function avatarActive(): boolean {
  return vrm !== null;
}

export async function initAvatar(canvas: HTMLCanvasElement): Promise<boolean> {
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(30, canvas.clientWidth / canvas.clientHeight, 0.1, 20);
    camera.position.set(0, 1.35, 1.6);

    scene.add(new THREE.DirectionalLight(0xffffff, 1.2));

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync('/avatar.vrm');
    vrm = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    scene.add(gltf.scene);

    // find the mouth blendshape proxy if the model has one
    const head = vrm.humanoid?.getNormalizedBoneNode('head');
    if (head) {
      // subtle sway target
    }
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = clock.getDelta();
      if (vrm) {
        vrm.update(dt);
        const headNode = vrm.humanoid?.getNormalizedBoneNode('head');
        if (headNode) {
          const t = clock.elapsedTime;
          headNode.rotation.y = Math.sin(t * 0.4) * 0.06;
          headNode.rotation.x = Math.sin(t * 0.3) * 0.03;
        }
      }
      renderer?.render(scene!, camera!);
    };
    loop();
    return true;
  } catch {
    return false; // fallback UI remains
  }
}

/** audioLevel: 0..1 RMS of the tutor playback. Drives mouth open amount. */
export function setAvatarMouth(level: number): void {
  if (!vrm) return;
  const expr = vrm.expressionManager;
  if (!expr) return;
  // 'aa' is the standard VRM viseme for mouth open
  expr.setValue('aa', Math.min(1, level * 4));
  expr.setValue('ih', Math.min(1, level * 2));
}

export function disposeAvatar(): void {
  cancelAnimationFrame(raf);
  renderer?.dispose();
  renderer = null; scene = null; vrm = null;
}
