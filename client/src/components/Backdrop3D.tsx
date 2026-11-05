import { useEffect, useRef } from "react";
import * as THREE from "three";
import { is3DEnabled } from "../lib/effects";

/**
 * Lightweight 3D backdrop used behind every non-room page: floating film reels, tickets and
 * play-button gems drifting in a soft indigo haze, with mouse + scroll parallax.
 * Fixed behind content, pauses when the tab is hidden, honours reduced-motion and the
 * "3D effects" switch in Settings, and keeps pixel ratio low so it stays cheap.
 */
export default function Backdrop3D({ density = 1 }: { density?: number }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !is3DEnabled()) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    } catch {
      return;
    }
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isSmall = window.matchMedia("(max-width: 640px)").matches;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 14);

    scene.add(new THREE.AmbientLight(0x6366f1, 0.9));
    const key = new THREE.PointLight(0x8b5cf6, 60, 40, 1.4);
    key.position.set(6, 6, 8);
    scene.add(key);
    const fill = new THREE.PointLight(0x22d3ee, 30, 40, 1.4);
    fill.position.set(-8, -4, 6);
    scene.add(fill);

    const palette = [0x6366f1, 0x8b5cf6, 0xd946ef, 0x22d3ee];
    const mat = (color: number) =>
      new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.25,
        metalness: 0.35,
        transparent: true,
        opacity: 0.55,
        clearcoat: 1,
        emissive: color,
        emissiveIntensity: 0.15,
      });

    // Film reel: outer ring + hub + spokes.
    const makeReel = (color: number) => {
      const g = new THREE.Group();
      const m = mat(color);
      g.add(new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 16, 48), m));
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.2, 24).rotateX(Math.PI / 2), m));
      for (let k = 0; k < 5; k++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.85, 0.06), m);
        spoke.position.set(Math.sin((k / 5) * Math.PI * 2) * 0.5, Math.cos((k / 5) * Math.PI * 2) * 0.5, 0);
        spoke.rotation.z = -(k / 5) * Math.PI * 2;
        g.add(spoke);
      }
      return g;
    };
    // Ticket: flat slab with notches suggested by two small cylinders cut visually.
    const makeTicket = (color: number) => {
      const shape = new THREE.Shape();
      const w = 1.6, h = 0.9, r = 0.18;
      shape.moveTo(-w / 2, -h / 2);
      shape.lineTo(w / 2, -h / 2);
      shape.lineTo(w / 2, -r);
      shape.absarc(w / 2, 0, r, -Math.PI / 2, Math.PI / 2, true);
      shape.lineTo(w / 2, h / 2);
      shape.lineTo(-w / 2, h / 2);
      shape.lineTo(-w / 2, r);
      shape.absarc(-w / 2, 0, r, Math.PI / 2, -Math.PI / 2, true);
      shape.lineTo(-w / 2, -h / 2);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2 });
      geo.center();
      return new THREE.Mesh(geo, mat(color));
    };
    // Play gem: triangular prism.
    const makePlay = (color: number) => {
      const geo = new THREE.CylinderGeometry(0.7, 0.7, 0.3, 3).rotateX(Math.PI / 2).rotateZ(-Math.PI / 2);
      return new THREE.Mesh(geo, mat(color));
    };

    const count = Math.round((isSmall ? 7 : 12) * density);
    const makers = [makeReel, makeTicket, makePlay];
    const items: { obj: THREE.Object3D; speed: number; spin: THREE.Vector3; baseY: number; phase: number; depth: number }[] = [];
    for (let i = 0; i < count; i++) {
      const obj = makers[i % makers.length](palette[i % palette.length]);
      const depth = -2 - Math.random() * 10;
      obj.position.set((Math.random() - 0.5) * 26, (Math.random() - 0.5) * 16, depth);
      obj.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      const s = 0.6 + Math.random() * 0.8;
      obj.scale.setScalar(s);
      scene.add(obj);
      items.push({
        obj,
        speed: 0.15 + Math.random() * 0.25,
        spin: new THREE.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.3),
        baseY: obj.position.y,
        phase: Math.random() * Math.PI * 2,
        depth,
      });
    }

    // Star dust.
    const dustN = isSmall ? 200 : 450;
    const dp = new Float32Array(dustN * 3);
    for (let i = 0; i < dustN; i++) {
      dp[i * 3] = (Math.random() - 0.5) * 40;
      dp[i * 3 + 1] = (Math.random() - 0.5) * 24;
      dp[i * 3 + 2] = -Math.random() * 20;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dp, 3));
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xc7d2fe, size: 0.04, transparent: true, opacity: 0.6, depthWrite: false }));
    scene.add(dust);

    const pointer = { x: 0, y: 0 };
    const onPointer = (e: PointerEvent) => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    const onResize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    const clock = new THREE.Clock();
    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      if (document.hidden) return;
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      if (!reduceMotion) {
        for (const it of items) {
          it.obj.rotation.x += it.spin.x * dt;
          it.obj.rotation.y += it.spin.y * dt;
          it.obj.rotation.z += it.spin.z * dt;
          it.obj.position.y = it.baseY + Math.sin(t * it.speed + it.phase) * 0.6;
        }
        dust.rotation.y = t * 0.01;
        const scroll = window.scrollY * 0.004;
        camera.position.x += (pointer.x * 1.4 - camera.position.x) * 0.03;
        camera.position.y += (-pointer.y * 0.9 - scroll - camera.position.y) * 0.03;
        camera.lookAt(0, -scroll, 0);
      }
      renderer.render(scene, camera);
    };
    render();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("resize", onResize);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose?.();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [density]);

  return <div ref={mountRef} className="pointer-events-none fixed inset-0 -z-10 opacity-80" aria-hidden="true" />;
}
