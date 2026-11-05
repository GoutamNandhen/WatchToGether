import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * A small 3D cinema for the landing page: a glowing curved screen, rows of seats,
 * a projector beam with drifting dust, and friend "avatar" orbs bobbing in the seats.
 * Plain three.js (no extra deps), lazy-loaded so it never slows the rest of the app.
 * Pauses when off-screen or the tab is hidden, and stays still for reduced-motion users.
 */
export default function Hero3D({ className = "" }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // Bail out quietly if WebGL is unavailable; the page still has its gradient backdrop.
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      return;
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isSmall = window.matchMedia("(max-width: 640px)").matches;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isSmall ? 1.5 : 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0807, 9, 26);

    const camera = new THREE.PerspectiveCamera(isSmall ? 62 : 48, mount.clientWidth / mount.clientHeight, 0.1, 100);
    const camBase = new THREE.Vector3(0, 2.6, 9.5);
    camera.position.copy(camBase);
    const lookTarget = new THREE.Vector3(0, 1.6, -4);
    camera.lookAt(lookTarget);

    // ---------- Screen: curved plane with an animated "movie" shader ----------
    const screenUniforms = { uTime: { value: 0 } };
    const screenGeo = new THREE.CylinderGeometry(12, 12, 4.6, 64, 1, true, Math.PI - 0.42, 0.84);
    const screenMat = new THREE.ShaderMaterial({
      uniforms: screenUniforms,
      side: THREE.BackSide,
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vec2 uv = vUv;
          float t = uTime * 0.25;
          // Drifting aurora-like "scene" in the brand colours.
          vec3 indigo = vec3(0.96, 0.71, 0.27); // gold
          vec3 violet = vec3(0.93, 0.42, 0.17); // copper
          vec3 cyan   = vec3(0.90, 0.28, 0.30); // crimson
          vec3 amber  = vec3(1.00, 0.93, 0.75); // highlight
          float w1 = sin(uv.x * 6.0 + t * 3.0) * 0.5 + 0.5;
          float w2 = sin(uv.y * 5.0 - t * 2.0 + uv.x * 3.0) * 0.5 + 0.5;
          vec3 col = mix(indigo, violet, w1);
          col = mix(col, cyan, w2 * 0.45);
          col += amber * smoothstep(0.75, 1.0, sin(uv.x * 2.0 - t * 1.5)) * 0.35;
          // Letterbox bars, vignette and scanlines for a cinema feel.
          float bars = step(0.1, uv.y) * step(uv.y, 0.9);
          float vig = smoothstep(0.95, 0.35, distance(uv, vec2(0.5)));
          float scan = 0.94 + 0.06 * sin(uv.y * 600.0);
          // Progress bar along the bottom.
          float prog = step(0.06, uv.y) * step(uv.y, 0.075) * step(0.05, uv.x) * step(uv.x, 0.95);
          float filled = step(uv.x, 0.05 + 0.9 * fract(uTime * 0.02 + 0.42));
          vec3 progCol = mix(vec3(0.25), vec3(1.0, 0.85, 0.5), filled);
          vec3 outCol = col * vig * scan * bars * 1.15 + progCol * prog;
          gl_FragColor = vec4(outCol, 1.0);
        }
      `,
    });
    const screen = new THREE.Mesh(screenGeo, screenMat);
    screen.position.set(0, 2.4, 7.5);
    scene.add(screen);

    // Soft glow the screen throws into the room.
    const screenLight = new THREE.PointLight(0xf5a54a, 30, 18, 1.6);
    screenLight.position.set(0, 2.5, -3);
    scene.add(screenLight);
    scene.add(new THREE.AmbientLight(0x3a2620, 1.2));
    const rim = new THREE.DirectionalLight(0xffb36b, 0.6);
    rim.position.set(5, 6, 8);
    scene.add(rim);

    // ---------- Floor ----------
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x120e0c, roughness: 0.9, metalness: 0.1 })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    // ---------- Seats: instanced for performance ----------
    const rows = isSmall ? 3 : 4;
    const perRow = isSmall ? 7 : 9;
    const seatGroup = new THREE.Group();
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x6b1620, roughness: 0.55, metalness: 0.15 });
    const baseGeo = new THREE.BoxGeometry(0.9, 0.45, 0.85);
    const backGeo = new THREE.BoxGeometry(0.9, 0.9, 0.18);
    const bases = new THREE.InstancedMesh(baseGeo, seatMat, rows * perRow);
    const backs = new THREE.InstancedMesh(backGeo, seatMat, rows * perRow);
    const m = new THREE.Matrix4();
    const seatSpots: THREE.Vector3[] = [];
    let i = 0;
    for (let r = 0; r < rows; r++) {
      for (let s = 0; s < perRow; s++) {
        const x = (s - (perRow - 1) / 2) * 1.15;
        const z = 1.2 + r * 1.5;
        const y = 0.25 + r * 0.32; // stadium rake
        m.makeTranslation(x, y, z);
        bases.setMatrixAt(i, m);
        m.makeTranslation(x, y + 0.6, z + 0.38);
        backs.setMatrixAt(i, m);
        seatSpots.push(new THREE.Vector3(x, y + 0.85, z));
        i++;
      }
    }
    seatGroup.add(bases, backs);
    scene.add(seatGroup);

    // ---------- Friend avatars: glowing orbs in a few seats ----------
    const avatarColors = [0xf5b544, 0xf9666f, 0x5eead4, 0xfb8a4c, 0xa5b4fc];
    const picks = [perRow + 2, perRow + 4, perRow * 2 + 3, perRow + 6, perRow * 2 + 5].filter((n) => n < seatSpots.length);
    const avatars = picks.map((seatIdx, k) => {
      const color = avatarColors[k % avatarColors.length];
      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 32, 32),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6, roughness: 0.3 })
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 24, 24),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false })
      );
      orb.add(halo);
      orb.position.copy(seatSpots[seatIdx]);
      scene.add(orb);
      return { orb, base: seatSpots[seatIdx].clone(), phase: k * 1.3 };
    });

    // ---------- Projector beam with drifting dust ----------
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(3.2, 14, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffe2a8, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    // Tip at the projector behind the audience, widening toward the screen.
    beam.rotation.x = Math.PI / 2;
    beam.position.set(0, 4.2, 3.5);
    scene.add(beam);

    const dustCount = isSmall ? 260 : 600;
    const dustPos = new Float32Array(dustCount * 3);
    for (let d = 0; d < dustCount; d++) {
      dustPos[d * 3] = (Math.random() - 0.5) * 8;
      dustPos[d * 3 + 1] = Math.random() * 6;
      dustPos[d * 3 + 2] = -3 + Math.random() * 13;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
    const dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({ color: 0xffe9c2, size: 0.035, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    scene.add(dust);

    // ---------- Interaction & loop ----------
    const pointer = { x: 0, y: 0 };
    const onPointer = (e: PointerEvent) => {
      const rect = mount.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    };
    window.addEventListener("pointermove", onPointer, { passive: true });

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    let visible = true;
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    io.observe(mount);

    const clock = new THREE.Clock();
    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      if (!visible || document.hidden) return;
      const t = clock.getElapsedTime();
      screenUniforms.uTime.value = t;

      if (!reduceMotion) {
        avatars.forEach(({ orb, base, phase }) => {
          orb.position.y = base.y + Math.sin(t * 1.6 + phase) * 0.08;
        });
        const pos = dustGeo.attributes.position as THREE.BufferAttribute;
        for (let d = 0; d < dustCount; d++) {
          let y = pos.getY(d) + 0.0025;
          if (y > 6) y = 0;
          pos.setY(d, y);
        }
        pos.needsUpdate = true;
        screenLight.intensity = 28 + Math.sin(t * 2.3) * 4 + Math.sin(t * 7.1) * 1.5;

        camera.position.x += (camBase.x + pointer.x * 1.2 - camera.position.x) * 0.04;
        camera.position.y += (camBase.y - pointer.y * 0.5 - camera.position.y) * 0.04;
        camera.lookAt(lookTarget);
      }
      renderer.render(scene, camera);
    };
    render();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
      ro.disconnect();
      io.disconnect();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={mountRef} className={className} aria-hidden="true" />;
}
