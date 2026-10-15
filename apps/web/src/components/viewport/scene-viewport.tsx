"use client";

/**
 * Live 3D Scene Viewport.
 *
 * Renders the 3D scene using Three.js with:
 * - 6 procedural primitives: box, cylinder, sphere, cone, torus, capsule.
 * - PBR MeshStandardMaterial (color, roughness, metalness, opacity, emissive).
 * - OrbitControls for pan, zoom, rotate.
 * - Subtle floor grid at y = 0 and 3-point studio lighting rig.
 * - Click-to-select raycasting with outline/emissive highlighting synced to SceneStore.
 * - Headless test hooks: window.__VIBE_VR_PREVIEW__ and window.__VIBE_VR_RENDER_CANDIDATE__
 *   for Gate 3 Vision Validator screenshot captures.
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  type GeometrySpec,
  type SceneNode,
  useSceneStore,
} from "../../store/scene-store.ts";

export type SceneViewportProps = {
  className?: string;
  onSelectNode?: (nodeId: string | null) => void;
};

const SELECTION_EMISSIVE_HEX = 0x7c5cff;

/** Converts degrees to radians. */
const degToRad = (deg: number) => (deg * Math.PI) / 180;

/** Builds a Three.js BufferGeometry for one of the 6 supported procedural primitives. */
export function createGeometry(spec: GeometrySpec): THREE.BufferGeometry {
  switch (spec.kind) {
    case "box":
      return new THREE.BoxGeometry(spec.width, spec.height, spec.depth);
    case "cylinder":
      return new THREE.CylinderGeometry(
        spec.radiusTop,
        spec.radiusBottom,
        spec.height,
        spec.radialSegments ?? 32,
      );
    case "sphere":
      return new THREE.SphereGeometry(
        spec.radius,
        spec.widthSegments ?? 32,
        Math.max(16, Math.floor((spec.widthSegments ?? 32) / 2)),
      );
    case "cone":
      return new THREE.ConeGeometry(
        spec.radius,
        spec.height,
        spec.radialSegments ?? 32,
      );
    case "torus":
      return new THREE.TorusGeometry(
        spec.radius,
        spec.tube,
        16,
        48,
        spec.arc ?? Math.PI * 2,
      );
    case "capsule":
      return new THREE.CapsuleGeometry(spec.radius, spec.length, 8, 16);
  }
}

/** Configures standard studio tone mapping, shadows and color pipeline. */
function configureRenderer(renderer: THREE.WebGLRenderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

declare global {
  interface Window {
    __VIBE_VR_PREVIEW__?: {
      renderCandidate: (
        candidateJson: unknown,
        cameraAngle?: [number, number, number],
      ) => string;
      captureScreenshot: () => string;
    };
    __VIBE_VR_RENDER_CANDIDATE__?: (
      candidateJson: unknown,
      cameraAngle?: [number, number, number],
    ) => string;
  }
}

export function SceneViewport({
  className = "h-full w-full",
  onSelectNode,
}: SceneViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const { nodes, selectedNodeId, setSelectedNodeId } = useSceneStore();

  const [unavailable, setUnavailable] = useState(false);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const rootGroupRef = useRef<THREE.Group | null>(null);
  const meshMapRef = useRef<Map<string, THREE.Object3D>>(new Map());

  // Mount Three.js canvas & studio rig
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        preserveDrawingBuffer: true, // Needed for screenshot capture
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      configureRenderer(renderer);
      rendererRef.current = renderer;
    } catch {
      setUnavailable(true);
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c10);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    camera.position.set(2.5, 2.0, 3.5);
    camera.lookAt(0, 0.5, 0);
    cameraRef.current = camera;

    let controls: OrbitControls | null = null;
    try {
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.target.set(0, 0.5, 0);
      controlsRef.current = controls;
    } catch {
      controls = null;
    }

    // Studio Lighting Rig
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xfff5ea, 2.0);
    keyLight.position.set(3, 5, 4);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xdce7ff, 0.8);
    fillLight.position.set(-3, 3, -3);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.6);
    rimLight.position.set(0, 4, -4);
    scene.add(rimLight);

    // Floor Grid at y = 0
    const grid = new THREE.GridHelper(10, 20, 0x3b4252, 0x1f2430);
    grid.position.y = 0;
    scene.add(grid);

    // Root group for model nodes
    const rootGroup = new THREE.Group();
    scene.add(rootGroup);
    rootGroupRef.current = rootGroup;

    // Animation loop
    let animFrame = 0;
    const animate = () => {
      animFrame = requestAnimationFrame(animate);
      controls?.update();
      renderer.render(scene, camera);
    };
    animate();

    // Resize handler
    const resize = () => {
      if (!container || !renderer) return;
      const rect = container.getBoundingClientRect();
      const width = Math.max(rect.width, 1);
      const height = Math.max(rect.height, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    resize();

    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(container);

    // Setup Headless Test Hooks for Gate 3 Vision Validator
    const captureScreenshot = (): string => {
      renderer.render(scene, camera);
      return canvas.toDataURL("image/png");
    };

    const renderCandidate = (
      _candidateJson: unknown,
      cameraAngle?: [number, number, number],
    ): string => {
      if (cameraAngle) {
        camera.position.set(cameraAngle[0], cameraAngle[1], cameraAngle[2]);
        camera.lookAt(0, 0.5, 0);
      }
      return captureScreenshot();
    };

    window.__VIBE_VR_PREVIEW__ = {
      renderCandidate,
      captureScreenshot,
    };
    window.__VIBE_VR_RENDER_CANDIDATE__ = renderCandidate;

    return () => {
      cancelAnimationFrame(animFrame);
      observer?.disconnect();
      controls?.dispose();
      renderer.dispose();
      delete window.__VIBE_VR_PREVIEW__;
      delete window.__VIBE_VR_RENDER_CANDIDATE__;
    };
  }, []);

  // Sync nodes from store to Three.js scene graph
  useEffect(() => {
    const rootGroup = rootGroupRef.current;
    if (!rootGroup) return;

    // Clear previous children
    while (rootGroup.children.length > 0) {
      const child = rootGroup.children[0];
      if (child) {
        rootGroup.remove(child);
      }
    }
    meshMapRef.current.clear();

    const objectMap = new Map<string, THREE.Object3D>();

    // Pass 1: Instantiate Three.js objects
    for (const [id, node] of Object.entries(nodes)) {
      let obj: THREE.Object3D;

      if (node.nodeType === "group" || !node.geometry) {
        obj = new THREE.Group();
      } else {
        const geom = createGeometry(node.geometry);
        const mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(node.material?.color ?? "#94a3b8"),
          roughness: node.material?.roughness ?? 0.5,
          metalness: node.material?.metalness ?? 0.0,
          opacity: node.material?.opacity ?? 1.0,
          transparent: (node.material?.opacity ?? 1.0) < 1.0,
          emissive: new THREE.Color(
            node.nodeId === selectedNodeId
              ? SELECTION_EMISSIVE_HEX
              : node.material?.emissive ?? "#000000",
          ),
          emissiveIntensity:
            node.nodeId === selectedNodeId
              ? 0.5
              : node.material?.emissiveIntensity ?? 0,
        });

        const mesh = new THREE.Mesh(geom, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        obj = mesh;
      }

      obj.name = node.name;
      obj.userData.nodeId = id;
      obj.position.set(...node.transform.position);
      obj.rotation.set(
        degToRad(node.transform.rotationDeg[0]),
        degToRad(node.transform.rotationDeg[1]),
        degToRad(node.transform.rotationDeg[2]),
      );
      obj.scale.set(...node.transform.scale);

      objectMap.set(id, obj);
      meshMapRef.current.set(id, obj);
    }

    // Pass 2: Attach to hierarchy
    for (const [id, node] of Object.entries(nodes)) {
      const obj = objectMap.get(id);
      if (!obj) continue;

      if (node.parentId && objectMap.has(node.parentId)) {
        objectMap.get(node.parentId)?.add(obj);
      } else {
        rootGroup.add(obj);
      }
    }
  }, [nodes, selectedNodeId]);

  // Click-to-select raycaster
  const handlePointerDown = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    handlePointerDown.current = { x: e.clientX, y: e.clientY };
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!handlePointerDown.current) return;
    const dx = Math.abs(e.clientX - handlePointerDown.current.x);
    const dy = Math.abs(e.clientY - handlePointerDown.current.y);
    handlePointerDown.current = null;

    // Discard pointer drags (orbit/pan)
    if (dx > 5 || dy > 5) return;

    const canvas = canvasRef.current;
    const camera = cameraRef.current;
    const rootGroup = rootGroupRef.current;
    if (!canvas || !camera || !rootGroup) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(rootGroup.children, true);
    if (intersects.length > 0) {
      let target: THREE.Object3D | null = intersects[0]?.object ?? null;
      while (target && !target.userData.nodeId && target.parent !== rootGroup) {
        target = target.parent;
      }
      const hitNodeId = target?.userData.nodeId as string | undefined;
      const selected = hitNodeId ?? null;
      setSelectedNodeId(selected);
      onSelectNode?.(selected);
    } else {
      setSelectedNodeId(null);
      onSelectNode?.(null);
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative min-h-[300px] overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950 ${className}`}
    >
      <canvas
        ref={canvasRef}
        aria-label="3D Viewport. Orbit: Left Click. Pan: Right Click. Zoom: Wheel."
        className="block h-full w-full outline-none"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      />

      {unavailable && (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-neutral-400 backdrop-blur-sm"
        >
          3D WebGL preview unavailable. Use the scene tree and inspector to edit nodes.
        </div>
      )}
    </div>
  );
}
