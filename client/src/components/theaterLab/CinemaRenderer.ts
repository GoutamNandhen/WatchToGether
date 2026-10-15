import * as THREE from "three";

export type TheaterQuality = "low" | "medium" | "high";
export type TheaterSeat = "gallery" | "center" | "front";

type RendererReport = { fps: number | null; error: string | null };

const SCREEN_WIDTH = 12.8;
const SCREEN_HEIGHT = 7.2;
const SCREEN_Y = 4.35;
const SCREEN_Z = -15.3;

const SEATS: Record<TheaterSeat, THREE.Vector3> = {
  gallery: new THREE.Vector3(0, 2.1, 13.4),
  center: new THREE.Vector3(0, 1.95, 8.4),
  front: new THREE.Vector3(0, 1.8, 3.1),
};

/** Owns only the experimental scene. It never reads or writes room state. */
export class CinemaRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly mobile: boolean;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(63, 1, 0.05, 90);
  private readonly stereoCamera = new THREE.StereoCamera();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly unitBox = new THREE.BoxGeometry(1, 1, 1);
  private readonly placeholderCanvas = document.createElement("canvas");
  private readonly placeholderTexture: THREE.CanvasTexture;
  private readonly screenMaterial: THREE.MeshBasicMaterial;
  private readonly screenMesh: THREE.Mesh;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly targetSeat = SEATS.gallery.clone();
  private readonly resizeObserver: ResizeObserver;
  private readonly onReport: (report: RendererReport) => void;
  private readonly onVisibility = () => {
    if (document.hidden) this.stop();
    else this.start();
  };
  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.fail("WebGL context lost. Reload this lab to restore the scene.");
    this.stop();
  };
  private animationFrame = 0;
  private running = false;
  private disposed = false;
  private lastFrame = 0;
  private frames = 0;
  private fpsWindow = 0;
  private lastPlaceholderDraw = 0;
  private drawCount = 0;
  private width = 1;
  private height = 1;
  private quality: TheaterQuality = "medium";
  private stereo = false;
  private videoTexture: THREE.VideoTexture | null = null;
  private manualYaw = 0;
  private manualPitch = 0.095;
  private sensorQuaternion: THREE.Quaternion | null = null;
  private sensorRecenter: THREE.Quaternion | null = null;
  private lastError: string | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    mobile: boolean,
    onReport: (report: RendererReport) => void,
  ) {
    this.canvas = canvas;
    this.mobile = mobile;
    this.onReport = onReport;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !mobile,
      powerPreference: "low-power",
      stencil: false,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.background = new THREE.Color("#08090b");
    this.scene.fog = new THREE.FogExp2("#08090b", 0.018);
    this.camera.position.copy(SEATS.gallery);
    this.stereoCamera.aspect = 0.5;
    this.stereoCamera.eyeSep = 0.065;

    this.placeholderCanvas.width = 768;
    this.placeholderCanvas.height = 432;
    this.placeholderTexture = new THREE.CanvasTexture(this.placeholderCanvas);
    this.placeholderTexture.colorSpace = THREE.SRGBColorSpace;
    this.placeholderTexture.minFilter = THREE.LinearFilter;
    this.screenMaterial = new THREE.MeshBasicMaterial({ map: this.placeholderTexture, toneMapped: false, fog: false });
    this.materials.push(this.screenMaterial);
    const screenGeometry = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(screenGeometry);
    this.screenMesh = new THREE.Mesh(screenGeometry, this.screenMaterial);
    this.screenMesh.position.set(0, SCREEN_Y, SCREEN_Z + 0.03);
    this.screenMesh.scale.set(SCREEN_WIDTH, SCREEN_HEIGHT, 1);
    this.scene.add(this.screenMesh);
    this.buildCinema();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.resize();
    this.start();
  }

  private material(color: string, metalness = 0, roughness = 0.9) {
    const material = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    this.materials.push(material);
    return material;
  }

  private glow(color: string) {
    const material = new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false });
    this.materials.push(material);
    return material;
  }

  private addBox(x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material) {
    const mesh = new THREE.Mesh(this.unitBox, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    this.scene.add(mesh);
    return mesh;
  }

  private buildCinema() {
    const charcoal = this.material("#141518");
    const wall = this.material("#1c1a19");
    const panel = this.material("#24211e");
    const carpet = this.material("#171216", 0, 1);
    const velvet = this.material("#362329", 0, 0.95);
    const seatFrame = this.material("#171418", 0.15, 0.75);
    const bronze = this.material("#625039", 0.62, 0.38);
    const gold = this.glow("#9b7040");
    const softGold = this.glow("#4d3722");
    const screenBack = this.glow("#020304");

    this.addBox(0, -0.12, 0, 25, 0.25, 37, carpet);
    this.addBox(0, 8.8, 0, 25, 0.25, 37, charcoal);
    this.addBox(-12.25, 4.3, 0, 0.3, 9, 37, wall);
    this.addBox(12.25, 4.3, 0, 0.3, 9, 37, wall);
    this.addBox(0, 4.3, -17, 25, 9, 0.35, wall);
    this.addBox(0, 4.3, 18, 25, 9, 0.35, wall);

    // Proscenium and screen; bright details use unlit strips rather than costly bloom.
    this.addBox(0, SCREEN_Y, SCREEN_Z - 0.08, 13.5, 7.85, 0.22, bronze);
    this.addBox(0, SCREEN_Y, SCREEN_Z - 0.025, SCREEN_WIDTH, SCREEN_HEIGHT, 0.08, screenBack);
    this.addBox(0, 8.35, SCREEN_Z + 0.04, 14.8, 0.045, 0.09, gold);
    this.addBox(0, 0.38, SCREEN_Z + 0.04, 14.8, 0.035, 0.09, softGold);
    this.addBox(-7.36, SCREEN_Y, SCREEN_Z + 0.04, 0.05, 8, 0.09, softGold);
    this.addBox(7.36, SCREEN_Y, SCREEN_Z + 0.04, 0.05, 8, 0.09, softGold);
    this.addBox(0, 0.12, -14.9, 16.8, 0.24, 3.3, charcoal);

    // Art-deco wall bays, aisle lights and restrained ceiling ribs.
    for (let i = 0; i < 8; i++) {
      const z = -12.8 + i * 4.1;
      for (const side of [-1, 1]) {
        this.addBox(side * 12.01, 4.35, z, 0.11, 6.9, 3.45, panel);
        this.addBox(side * 11.9, 4.35, z - 1.72, 0.12, 7.1, 0.07, bronze);
        this.addBox(side * 11.88, 5.55, z, 0.14, 1.75, 0.045, softGold);
        this.addBox(side * 10.8, 0.13, z, 0.035, 0.02, 1.2, gold);
      }
      this.addBox(0, 8.58, z, 23.6, 0.07, 0.08, bronze);
      this.addBox(0, 8.5, z + 0.09, 11.2, 0.025, 0.025, softGold);
    }
    this.addBox(-1.27, 0.015, 1.5, 0.025, 0.02, 29, softGold);
    this.addBox(1.27, 0.015, 1.5, 0.025, 0.02, 29, softGold);

    // Four instanced batches draw all seats, preserving detail on slower phones.
    const positions: Array<[number, number]> = [];
    const seatXs = [-9.1, -7.25, -5.4, -3.55, 3.55, 5.4, 7.25, 9.1];
    for (const z of [-0.7, 2.4, 5.5, 8.6, 11.7, 14.8]) {
      for (const x of seatXs) positions.push([x, z]);
    }
    const dummy = new THREE.Object3D();
    const addSeatPart = (material: THREE.Material, part: (x: number, z: number) => [number, number, number, number, number, number]) => {
      const mesh = new THREE.InstancedMesh(this.unitBox, material, positions.length);
      positions.forEach(([x, z], index) => {
        const [px, py, pz, sx, sy, sz] = part(x, z);
        dummy.position.set(px, py, pz);
        dummy.scale.set(sx, sy, sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
    };
    addSeatPart(seatFrame, (x, z) => [x, 0.43, z, 1.48, 0.72, 1.12]);
    addSeatPart(velvet, (x, z) => [x, 1.06, z + 0.36, 1.35, 1.38, 0.29]);
    addSeatPart(velvet, (x, z) => [x, 0.77, z - 0.22, 1.35, 0.22, 0.92]);
    addSeatPart(bronze, (x, z) => [x - 0.79, 0.79, z - 0.06, 0.12, 0.16, 1.13]);
    addSeatPart(bronze, (x, z) => [x + 0.79, 0.79, z - 0.06, 0.12, 0.16, 1.13]);

    this.scene.add(new THREE.AmbientLight("#c7b8a4", 1.45));
    const screenLight = new THREE.PointLight("#af8555", 18, 32, 2);
    screenLight.position.set(0, 6.8, -12.5);
    this.scene.add(screenLight);
    const rearLight = new THREE.PointLight("#9c6839", 8, 18, 2);
    rearLight.position.set(0, 7.8, 12);
    this.scene.add(rearLight);
  }

  private paintPlaceholder(time: number) {
    const ctx = this.placeholderCanvas.getContext("2d");
    if (!ctx) return;
    const w = this.placeholderCanvas.width;
    const h = this.placeholderCanvas.height;
    const sweep = (time * 0.000035) % 1;
    const background = ctx.createLinearGradient(0, 0, w, h);
    background.addColorStop(0, "#06090c");
    background.addColorStop(0.55, "#141318");
    background.addColorStop(1, "#050608");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    const halo = ctx.createRadialGradient(w * (0.32 + sweep * 0.35), h * 0.48, 0, w * 0.5, h * 0.48, w * 0.65);
    halo.addColorStop(0, "rgba(136,93,51,0.22)");
    halo.addColorStop(1, "rgba(136,93,51,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(199,156,93,0.4)";
    ctx.lineWidth = 2;
    ctx.strokeRect(45, 44, w - 90, h - 88);
    ctx.strokeStyle = "rgba(199,156,93,0.16)";
    ctx.strokeRect(58, 57, w - 116, h - 114);
    ctx.save();
    ctx.translate(w / 2, h / 2 - 28);
    ctx.rotate(time * 0.00013);
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      ctx.fillStyle = `rgba(216,174,109,${0.12 + (i % 3) * 0.06})`;
      ctx.fillRect(Math.cos(angle) * 74 - 1, Math.sin(angle) * 74 - 1, 3, 3);
    }
    ctx.restore();
    ctx.textAlign = "center";
    ctx.fillStyle = "#d9bb86";
    ctx.font = "600 15px Georgia, serif";
    ctx.fillText("WATCHTOGETHER  ·  PRIVATE SCREENING", w / 2, h / 2 - 91);
    ctx.fillStyle = "#f4efe5";
    ctx.font = "54px Georgia, serif";
    ctx.fillText("THE CINEMA IS YOURS", w / 2, h / 2 + 52);
    ctx.fillStyle = "#a89b87";
    ctx.font = "18px Arial, sans-serif";
    ctx.fillText("Choose a local film to begin", w / 2, h / 2 + 97);
    this.placeholderTexture.needsUpdate = true;
  }

  private resize() {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setQuality(quality: TheaterQuality) {
    this.quality = quality;
    const cap = quality === "low" ? 1 : quality === "medium" ? 1.35 : this.mobile ? 1.7 : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this.renderer.setSize(this.width, this.height, false);
  }

  setSeat(seat: TheaterSeat) {
    this.targetSeat.copy(SEATS[seat]);
  }

  look(dx: number, dy: number) {
    if (this.sensorQuaternion) return;
    this.manualYaw -= dx * 0.003;
    this.manualPitch = THREE.MathUtils.clamp(this.manualPitch - dy * 0.003, -0.72, 0.72);
  }

  useMotion(alpha: number, beta: number, gamma: number, screenAngle: number) {
    const euler = new THREE.Euler(THREE.MathUtils.degToRad(beta), THREE.MathUtils.degToRad(alpha), -THREE.MathUtils.degToRad(gamma), "YXZ");
    const q = new THREE.Quaternion().setFromEuler(euler);
    q.multiply(new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -THREE.MathUtils.degToRad(screenAngle)));
    this.sensorQuaternion = q;
    if (!this.sensorRecenter) this.recenter();
  }

  disableMotion() {
    this.sensorQuaternion = null;
    this.sensorRecenter = null;
  }

  recenter() {
    if (this.sensorQuaternion) this.sensorRecenter = this.sensorQuaternion.clone().invert();
    else {
      this.manualYaw = 0;
      this.manualPitch = 0.095;
    }
  }

  setStereo(enabled: boolean, eyeSeparation = this.stereoCamera.eyeSep) {
    this.stereo = enabled;
    this.stereoCamera.eyeSep = eyeSeparation;
  }

  setEyeSeparation(value: number) {
    this.stereoCamera.eyeSep = value;
  }

  setVideo(video: HTMLVideoElement | null) {
    this.videoTexture?.dispose();
    this.videoTexture = null;
    this.screenMaterial.map = this.placeholderTexture;
    this.screenMesh.scale.set(SCREEN_WIDTH, SCREEN_HEIGHT, 1);
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      const texture = new THREE.VideoTexture(video);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      this.videoTexture = texture;
      this.screenMaterial.map = texture;
      const fit = Math.min(SCREEN_WIDTH / video.videoWidth, SCREEN_HEIGHT / video.videoHeight);
      this.screenMesh.scale.set(video.videoWidth * fit, video.videoHeight * fit, 1);
    }
    this.screenMaterial.needsUpdate = true;
  }

  private fail(message: string) {
    if (this.lastError === message) return;
    this.lastError = message;
    this.onReport({ fps: null, error: message });
  }

  private frame = (time: number) => {
    if (!this.running || this.disposed) return;
    this.animationFrame = requestAnimationFrame(this.frame);
    const delta = this.lastFrame ? Math.min((time - this.lastFrame) / 1000, 0.1) : 0;
    this.lastFrame = time;
    this.camera.position.lerp(this.targetSeat, Math.min(1, delta * 3.5));
    if (this.sensorQuaternion && this.sensorRecenter) {
      this.camera.quaternion.copy(this.sensorQuaternion).premultiply(this.sensorRecenter);
    } else {
      this.camera.quaternion.setFromEuler(new THREE.Euler(this.manualPitch, this.manualYaw, 0, "YXZ"));
    }
    const placeholderInterval = this.quality === "low" ? 83 : this.quality === "medium" ? 50 : 33;
    if (!this.videoTexture && time - this.lastPlaceholderDraw > placeholderInterval) {
      this.paintPlaceholder(time);
      this.lastPlaceholderDraw = time;
    }
    try {
      if (this.stereo) {
        this.stereoCamera.update(this.camera);
        const half = Math.floor(this.width / 2);
        this.renderer.setScissorTest(true);
        this.renderer.setViewport(0, 0, half, this.height);
        this.renderer.setScissor(0, 0, half, this.height);
        this.renderer.render(this.scene, this.stereoCamera.cameraL);
        this.renderer.setViewport(half, 0, this.width - half, this.height);
        this.renderer.setScissor(half, 0, this.width - half, this.height);
        this.renderer.render(this.scene, this.stereoCamera.cameraR);
        this.renderer.setScissorTest(false);
      } else {
        this.renderer.setViewport(0, 0, this.width, this.height);
        this.renderer.render(this.scene, this.camera);
      }
      if (++this.drawCount % 120 === 0 && this.renderer.getContext().getError() !== 0) {
        this.fail("The browser reported a WebGL rendering error.");
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "The scene could not render.");
      this.stop();
      return;
    }
    this.frames++;
    if (time - this.fpsWindow >= 1000) {
      this.onReport({ fps: Math.round((this.frames * 1000) / (time - this.fpsWindow)), error: this.lastError });
      this.frames = 0;
      this.fpsWindow = time;
    }
  };

  private start() {
    if (this.running || this.disposed || document.hidden) return;
    this.running = true;
    this.lastFrame = 0;
    this.frames = 0;
    this.fpsWindow = performance.now();
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  private stop() {
    this.running = false;
    cancelAnimationFrame(this.animationFrame);
    this.onReport({ fps: null, error: this.lastError });
  }

  dispose() {
    this.disposed = true;
    this.stop();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.resizeObserver.disconnect();
    this.videoTexture?.dispose();
    this.placeholderTexture.dispose();
    this.unitBox.dispose();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.renderer.dispose();
  }
}
