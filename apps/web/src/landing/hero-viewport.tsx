"use client";

/**
 * The hero's visual: a sample chair on a quiet studio floor.
 *
 * A CC-BY 4.0 sample model (see `public/models/sheen-chair.LICENSE.txt`), not
 * something Vibe-VR generated — the caption says exactly that. It stands in
 * for the editable 3D objects the product works on: real PBR materials with
 * sheen, studio lighting, a soft contact shadow, and a faint technical grid
 * that echoes the page behind it. No browser chrome, no counters, no diagnostic
 * captions.
 *
 * The renderer and the model load arrive as props so tests can inject fakes
 * and verify the lifecycle — loading, ready, unavailable — without WebGL or a
 * network. Where either is missing (headless DOM, blocked context, failed
 * fetch), the figure says so and the caption still reads, so the hero degrades
 * to a labelled space rather than a hole.
 *
 * It never takes input beyond orbiting: the hero is a doorway, and the
 * conversation lives behind sign-in in the workbench.
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/** The sample chair, served as a static asset. See the LICENSE beside it. */
export const CHAIR_MODEL_URL = "/models/sheen-chair.glb";

type ViewportStatus = "loading" | "ready" | "unavailable";

export type ChairRenderer = {
  render: (scene: THREE.Scene, camera: THREE.Camera) => void;
  setSize: (width: number, height: number) => void;
  dispose: () => void;
};

export function defaultCreateChairRenderer(canvas: HTMLCanvasElement): ChairRenderer | null {
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // A lit object on the cream page, not a second dark room: the canvas stays
    // transparent and the floor below is drawn in-scene.
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    return {
      render: (scene, camera) => renderer.render(scene, camera),
      setSize: (width, height) => renderer.setSize(width, height, false),
      dispose: () => renderer.dispose(),
    };
  } catch {
    return null;
  }
}

export function defaultLoadChairModel(url: string): Promise<THREE.Group> {
  return new GLTFLoader().loadAsync(url).then((gltf) => gltf.scene);
}

/**
 * Frame the camera on the model's bounds: the chair fills the canvas with
 * room around it, from a restrained three-quarter view slightly above.
 */
function frameChair(camera: THREE.PerspectiveCamera, box: THREE.Box3): THREE.Vector3 {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const direction = new THREE.Vector3(-0.62, 0.42, 1).normalize();
  const distance = (maxDim / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.35;
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = distance * 50;
  camera.updateProjectionMatrix();
  return center;
}

/**
 * Release everything a chair viewport allocated: geometries, materials,
 * textures, controls and the renderer itself. Disposal is idempotent, so a
 * texture shared by two materials can be released twice without complaint.
 */
function disposeObject(root: THREE.Object3D, controls: OrbitControls | null): void {
  controls?.dispose();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    (mesh.geometry as THREE.BufferGeometry | undefined)?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    const materials = Array.isArray(material) ? material : material !== undefined ? [material] : [];
    for (const entry of materials) {
      for (const texture of Object.values(entry)) {
        if (texture instanceof THREE.Texture) texture.dispose();
      }
      entry.dispose();
    }
  });
}

export function HeroViewport({
  modelUrl = CHAIR_MODEL_URL,
  createRenderer = defaultCreateChairRenderer,
  loadModel = defaultLoadChairModel,
}: {
  modelUrl?: string;
  createRenderer?: (canvas: HTMLCanvasElement) => ChairRenderer | null;
  loadModel?: (url: string) => Promise<THREE.Group>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<ViewportStatus>("loading");

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;
    let renderer: ChairRenderer | null = null;
    try {
      renderer = createRenderer(canvas);
    } catch {
      renderer = null;
    }
    if (renderer === null) {
      setStatus("unavailable");
      return;
    }
    setStatus("loading");

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    let controls: OrbitControls | null = null;

    // Studio light: an image-based environment for the PBR sheen, plus one
    // soft key light that draws the contact shadow. Restrained by design —
    // this is a workbench, not a showroom.
    //
    // The cast below is the seam between the injectable handle and three's
    // concrete type: the fake renderers tests inject fail here and fall into
    // the catch, which is exactly the degraded path they are verifying.
    let pmrem: THREE.PMREMGenerator | null = null;
    try {
      pmrem = new THREE.PMREMGenerator(renderer as unknown as THREE.WebGLRenderer);
      const room = new RoomEnvironment();
      scene.environment = pmrem.fromScene(room, 0.04).texture;
      scene.environmentIntensity = 0.85;
    } catch {
      scene.environment = null;
    } finally {
      pmrem?.dispose();
    }
    const key = new THREE.DirectionalLight(0xfff6e8, 1.15);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    scene.add(new THREE.HemisphereLight(0xfffdf6, 0xcfc4ae, 0.35));

    let cancelled = false;
    loadModel(modelUrl).then(
      (chair) => {
        if (cancelled) {
          disposeObject(chair, null);
          return;
        }
        chair.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          }
        });
        const box = new THREE.Box3().setFromObject(chair);
        const center = frameChair(camera, box);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);

        key.position.set(center.x + maxDim * 1.4, center.y + maxDim * 2.2, center.z + maxDim * 1.0);
        // The target must be in the scene or its transform never updates and
        // the light silently aims at the origin instead of the chair.
        key.target.position.copy(center);
        scene.add(key.target);
        key.shadow.camera.left = -maxDim;
        key.shadow.camera.right = maxDim;
        key.shadow.camera.top = maxDim;
        key.shadow.camera.bottom = -maxDim;
        key.shadow.camera.near = maxDim * 0.5;
        key.shadow.camera.far = maxDim * 6;
        key.shadow.camera.updateProjectionMatrix();

        // The floor: a shadow catcher with a faint technical grid, echoing the
        // page's own grid rather than inventing a second visual language.
        const groundY = box.min.y;
        const shadowCatcher = new THREE.Mesh(
          new THREE.CircleGeometry(maxDim * 3, 48),
          new THREE.ShadowMaterial({ opacity: 0.16 }),
        );
        shadowCatcher.rotation.x = -Math.PI / 2;
        shadowCatcher.position.y = groundY;
        shadowCatcher.receiveShadow = true;
        scene.add(shadowCatcher);
        const grid = new THREE.GridHelper(maxDim * 6, 24, 0xc4b89e, 0xdcd2ba);
        const gridMaterial = grid.material as THREE.Material;
        gridMaterial.transparent = true;
        gridMaterial.opacity = 0.55;
        grid.position.y = groundY + maxDim * 0.002;
        scene.add(grid);

        scene.add(chair);
        try {
          controls = new OrbitControls(camera, canvas);
          controls.enableDamping = true;
          controls.dampingFactor = 0.06;
          controls.enablePan = false;
          controls.target.copy(center);
          controls.minDistance = maxDim * 1.1;
          controls.maxDistance = maxDim * 4;
          // Stay above the floor: orbiting under it would show the underside
          // of an infinite grid, which reads as a rendering fault.
          controls.maxPolarAngle = Math.PI * 0.495;
          controls.update();
        } catch {
          controls = null;
        }
        setStatus("ready");
      },
      () => {
        if (!cancelled) setStatus("unavailable");
      },
    );

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(rect.width, 1);
      const height = Math.max(rect.height, 1);
      renderer?.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(container);

    // The loop only advances the frame; nothing moves on its own. Hidden tabs
    // pause it, following the workbench viewport's lead.
    let frame = 0;
    let stopped = false;
    let paused = false;
    const loop = () => {
      frame = 0;
      if (stopped || paused) return;
      controls?.update();
      renderer?.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    const onVisibility = () => {
      paused = document.hidden;
      if (!document.hidden && frame === 0 && !stopped) frame = requestAnimationFrame(loop);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      stopped = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
      disposeObject(scene, controls);
      const environment = scene.environment;
      scene.environment = null;
      environment?.dispose();
      renderer?.dispose();
    };
  }, [createRenderer, loadModel, modelUrl]);

  return (
    <figure aria-label="Editable 3D scene: sample chair model" className="relative text-left">
      <div ref={containerRef} className="relative h-80 overflow-hidden sm:h-[420px] lg:h-[460px]">
        <canvas
          ref={canvasRef}
          aria-label="Sample chair 3D scene. Drag to orbit."
          className="block h-full w-full touch-none"
        />
        {status === "loading" && (
          <p
            role="status"
            className="absolute top-4 left-4 rounded-full border border-[var(--s-border-1)] bg-[var(--s-surface-1)] px-3 py-1 font-mono text-[11px] text-[var(--s-text-muted)]"
          >
            Loading sample model…
          </p>
        )}
        {status === "unavailable" && (
          <p
            role="status"
            className="absolute inset-0 grid place-items-center px-8 text-center text-sm text-[var(--s-text-muted)]"
          >
            3D preview is unavailable here — the workbench viewport will still work where WebGL
            does.
          </p>
        )}
        {/*
          One quiet command, floating at the canvas edge. Decorative: the page copy already
          describes conversational editing, so this draws nothing extra in the accessibility
          tree — it is a hint of the product's voice, not a control.
        */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-4 left-4 flex items-center gap-2 rounded-full border border-[var(--s-border-1)] bg-[var(--s-surface-1)] py-1.5 pr-4 pl-3 shadow-[0_8px_24px_-12px_rgba(28,26,23,0.3)]"
        >
          <span className="inline-block size-1.5 rounded-full bg-[var(--s-accent)]" />
          <span className="font-mono text-[11px] text-[var(--s-text-body)]">
            “change the chair material”
          </span>
        </span>
      </div>

      <figcaption className="mt-4 flex items-baseline justify-between gap-4 text-[12px] text-[var(--s-text-subtle)]">
        <span>Explore an editable 3D scene — drag to orbit.</span>
        <span className="shrink-0 font-mono text-[11px]">
          Sample model © 2020 Wayfair LLC ·{" "}
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noreferrer"
            className="underline decoration-[var(--s-border-1)] underline-offset-2 transition-colors hover:text-[var(--s-text-muted)]"
          >
            CC-BY 4.0
          </a>
        </span>
      </figcaption>
    </figure>
  );
}
