import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import cinemaScreenArtwork from "./cinema-screen.webp";

export type TheaterQuality = "low" | "medium" | "high";
export type TheaterSeat = "gallery" | "center" | "front";

type RendererReport = { fps: number | null; error: string | null };

const SCREEN_WIDTH = 14.4;
const SCREEN_HEIGHT = 8.1;
const SCREEN_Y = 5.05;
const SCREEN_Z = -12;

const SEATS: Record<TheaterSeat, THREE.Vector3> = {
  gallery: new THREE.Vector3(2, 1.8, 11),
  center: new THREE.Vector3(2, 1.55, 4.4),
  front: new THREE.Vector3(2, 1.45, -0.6),
};

/** Owns only the experimental scene. It never reads or writes room state. */
export class CinemaRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly mobile: boolean;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(47, 1, 0.05, 90);
  private readonly stereoCamera = new THREE.StereoCamera();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly unitBox = new THREE.BoxGeometry(1, 1, 1);
  private readonly roundedBox = new RoundedBoxGeometry(1, 1, 1, 2, 0.09);
  private readonly placeholderCanvas = document.createElement("canvas");
  private readonly artworkImage = new Image();
  private artworkReady = false;
  private readonly placeholderTexture: THREE.CanvasTexture;
  private readonly screenMaterial: THREE.MeshBasicMaterial;
  private readonly screenMesh: THREE.Mesh;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
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
  private manualPitch = 0;
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
    this.renderer.toneMappingExposure = 1.38;
    this.scene.background = new THREE.Color("#110f12");
    this.scene.fog = new THREE.FogExp2("#110f12", 0.006);
    this.camera.position.copy(SEATS.center);
    this.faceScreen();
    this.stereoCamera.aspect = 0.5;
    this.stereoCamera.eyeSep = 0.065;

    this.placeholderCanvas.width = 1024;
    this.placeholderCanvas.height = 576;
    this.artworkImage.onload = () => {
      if (this.disposed) return;
      this.artworkReady = true;
      this.paintPlaceholder(performance.now());
    };
    this.placeholderTexture = new THREE.CanvasTexture(this.placeholderCanvas);
    this.placeholderTexture.colorSpace = THREE.SRGBColorSpace;
    this.placeholderTexture.minFilter = THREE.LinearFilter;
    this.screenMaterial = new THREE.MeshBasicMaterial({ map: this.placeholderTexture, color: "#ffffff", toneMapped: false, fog: false });
    this.materials.push(this.screenMaterial);
    const screenGeometry = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(screenGeometry);
    this.screenMesh = new THREE.Mesh(screenGeometry, this.screenMaterial);
    this.screenMesh.position.set(0, SCREEN_Y, SCREEN_Z + 0.12);
    this.screenMesh.scale.set(SCREEN_WIDTH, SCREEN_HEIGHT, 1);
    this.scene.add(this.screenMesh);
    this.artworkImage.src = cinemaScreenArtwork;
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

  private addInstances(material: THREE.Material, boxes: Array<[number, number, number, number, number, number]>, geometry: THREE.BufferGeometry = this.unitBox) {
    const mesh = new THREE.InstancedMesh(geometry, material, boxes.length);
    const instance = new THREE.Object3D();
    boxes.forEach(([x, y, z, w, h, d], index) => {
      instance.position.set(x, y, z);
      instance.scale.set(w, h, d);
      instance.updateMatrix();
      mesh.setMatrixAt(index, instance.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  private buildCinema() {
    const floor = this.material("#292226", 0.05, 0.94);
    const riser = this.material("#211a1e", 0.05, 0.92);
    const wall = this.material("#292428", 0.04, 0.93);
    const acoustic = this.material("#3a3034", 0.02, 1);
    const acousticInset = this.material("#211c22", 0.02, 1);
    const fabricSlat = this.material("#514148", 0.02, 1);
    const ceiling = this.material("#201d21", 0.05, 0.88);
    const velvet = this.material("#713d48", 0.02, 0.96);
    const seatCushion = this.material("#844b55", 0.02, 0.96);
    const seatFrame = this.material("#242026", 0.18, 0.72);
    const bronze = this.material("#92734e", 0.58, 0.4);
    const darkBronze = this.material("#604b38", 0.45, 0.5);
    const goldLight = this.glow("#d7aa6d");
    const lowLight = this.glow("#8e633d");
    const sconceHalo = this.glow("#61402e");
    const screenBack = this.glow("#030405");

    // A compact 30 m auditorium with gentle seating tiers and a screen above a low stage.
    this.addBox(0, -0.19, 1.4, 22, 0.38, 30, floor);
    this.addBox(0, 9.64, 1.4, 22, 0.28, 30, ceiling);
    this.addBox(-10.95, 4.7, 1.4, 0.28, 9.6, 30, wall);
    this.addBox(10.95, 4.7, 1.4, 0.28, 9.6, 30, wall);
    this.addBox(0, 4.7, -13.45, 22, 9.6, 0.25, wall);
    this.addBox(0, 4.7, 16.25, 22, 9.6, 0.25, wall);

    // The video plane is the frontmost surface. All luminous trim sits outside its bounds.
    this.addBox(0, SCREEN_Y, SCREEN_Z - 0.08, 15.2, 8.72, 0.2, darkBronze);
    this.addBox(0, SCREEN_Y, SCREEN_Z + 0.005, SCREEN_WIDTH, SCREEN_HEIGHT, 0.08, screenBack);
    this.addBox(0, 9.27, SCREEN_Z + 0.16, 15.15, 0.08, 0.1, bronze);
    this.addBox(0, 0.83, SCREEN_Z + 0.16, 15.15, 0.08, 0.1, bronze);
    this.addBox(-7.56, SCREEN_Y, SCREEN_Z + 0.16, 0.08, 8.8, 0.1, bronze);
    this.addBox(7.56, SCREEN_Y, SCREEN_Z + 0.16, 0.08, 8.8, 0.1, bronze);
    this.addBox(0, 9.32, SCREEN_Z + 0.22, 14.9, 0.025, 0.025, lowLight);
    this.addBox(0, 0.22, -11.48, 17.5, 0.42, 3.5, riser);
    this.addBox(0, 0.46, -9.8, 18, 0.05, 0.06, bronze);
    this.addBox(-8.7, 4.75, -12.82, 1.2, 8.7, 0.16, acousticInset);
    this.addBox(8.7, 4.75, -12.82, 1.2, 8.7, 0.16, acousticInset);

    const panels: Array<[number, number, number, number, number, number]> = [];
    const insetPanels: typeof panels = [];
    const slats: typeof panels = [];
    const verticalTrim: typeof panels = [];
    const sconces: typeof panels = [];
    const halos: typeof panels = [];
    const ceilingRibs: typeof panels = [];
    const ceilingGlow: typeof panels = [];
    const aisleLamps: typeof panels = [];
    const stepEdges: typeof panels = [];

    for (let bay = 0; bay < 6; bay++) {
      const z = -9.5 + bay * 4.45;
      for (const side of [-1, 1]) {
        panels.push([side * 10.77, 4.7, z, 0.14, 7.75, 3.7]);
        insetPanels.push([side * 10.67, 4.76, z, 0.08, 6.9, 3.22]);
        for (let slat = 0; slat < 5; slat++) {
          slats.push([side * 10.59, 4.75, z - 1.25 + slat * 0.62, 0.045, 5.7, 0.065]);
        }
        verticalTrim.push([side * 10.59, 4.7, z - 1.77, 0.12, 8.1, 0.075]);
        verticalTrim.push([side * 10.58, 1.18, z, 0.1, 0.055, 3.34]);
        halos.push([side * 10.5, 4.65, z + 0.4, 0.025, 1.66, 0.92]);
        sconces.push([side * 10.45, 4.65, z + 0.4, 0.06, 0.65, 0.16]);
      }
      ceilingRibs.push([0, 9.43, z - 1.98, 21, 0.18, 0.18]);
      ceilingGlow.push([0, 9.33, z - 1.98, 13.6, 0.025, 0.03]);
    }
    this.addInstances(acoustic, panels);
    this.addInstances(acousticInset, insetPanels);
    this.addInstances(fabricSlat, slats);
    this.addInstances(bronze, verticalTrim);
    this.addInstances(sconceHalo, halos);
    this.addInstances(goldLight, sconces);
    this.addInstances(darkBronze, ceilingRibs);
    this.addInstances(lowLight, ceilingGlow);
    this.addBox(-9.3, 9.3, 1.4, 0.08, 0.08, 29, darkBronze);
    this.addBox(9.3, 9.3, 1.4, 0.08, 0.08, 29, darkBronze);
    this.addBox(0, 9.28, 1.4, 7.9, 0.06, 28.4, acousticInset);

    const rowZ = [-1, 1.9, 4.8, 7.7, 10.6, 13.5];
    const seatX = [-8.6, -7, -5.4, -3.8, -2.2, 2.2, 3.8, 5.4, 7, 8.6];
    const seats: Array<[number, number, number]> = [];
    rowZ.forEach((z, row) => {
      const rise = row * 0.115;
      this.addBox(0, rise / 2 - 0.015, z, 21.3, rise + 0.07, 2.82, riser);
      stepEdges.push([0, rise + 0.03, z - 1.39, 21.2, 0.035, 0.045]);
      for (const x of seatX) seats.push([x, z, rise]);
      for (const side of [-1, 1]) {
        aisleLamps.push([side * 1.13, rise + 0.045, z - 1.17, 0.18, 0.04, 0.55]);
        aisleLamps.push([side * 9.97, rise + 0.045, z - 1.17, 0.18, 0.04, 0.55]);
      }
    });
    this.addInstances(darkBronze, stepEdges);
    this.addInstances(goldLight, aisleLamps);
    this.addBox(0, 0.015, 1.4, 2.14, 0.03, 28.5, floor);

    // Each upholstered chair uses shared low-poly rounded geometry and seven instanced parts.
    const frameParts: Array<[number, number, number, number, number, number]> = [];
    const backs: typeof frameParts = [];
    const headrests: typeof frameParts = [];
    const cushions: typeof frameParts = [];
    const sideBolsters: typeof frameParts = [];
    const armrests: typeof frameParts = [];
    const piping: typeof frameParts = [];
    seats.forEach(([x, z, rise]) => {
      frameParts.push([x, rise + 0.42, z, 1.46, 0.74, 1.24]);
      backs.push([x, rise + 1.21, z + 0.42, 1.35, 1.46, 0.38]);
      headrests.push([x, rise + 1.78, z + 0.43, 1.15, 0.32, 0.42]);
      cushions.push([x, rise + 0.85, z - 0.18, 1.26, 0.25, 0.94]);
      for (const side of [-1, 1]) {
        sideBolsters.push([x + side * 0.61, rise + 1.21, z + 0.38, 0.15, 1.3, 0.42]);
        armrests.push([x + side * 0.77, rise + 0.92, z - 0.06, 0.17, 0.3, 1.22]);
        piping.push([x + side * 0.75, rise + 1.08, z - 0.05, 0.035, 0.035, 1.13]);
      }
    });
    this.addInstances(seatFrame, frameParts, this.roundedBox);
    this.addInstances(velvet, backs, this.roundedBox);
    this.addInstances(seatCushion, headrests, this.roundedBox);
    this.addInstances(seatCushion, cushions, this.roundedBox);
    this.addInstances(velvet, sideBolsters, this.roundedBox);
    this.addInstances(seatFrame, armrests, this.roundedBox);
    this.addInstances(bronze, piping);

    // Static fills reveal upholstery and architecture; no shadow maps or post-processing.
    this.scene.add(new THREE.AmbientLight("#cbb8b2", 1.1));
    this.scene.add(new THREE.HemisphereLight("#f4dcc0", "#4c303a", 2.2));
    const frontFill = new THREE.DirectionalLight("#d6dee9", 1.25);
    frontFill.position.set(0, 8, -8);
    this.scene.add(frontFill);
    const aisleFill = new THREE.PointLight("#e2ae79", 55, 19, 2);
    aisleFill.position.set(0, 4.6, 5.5);
    this.scene.add(aisleFill);
  }

  private paintPlaceholder(time: number) {
    const ctx = this.placeholderCanvas.getContext("2d");
    if (!ctx) return;
    const w = this.placeholderCanvas.width;
    const h = this.placeholderCanvas.height;
    if (this.artworkReady) {
      ctx.drawImage(this.artworkImage, 0, 0, w, h);
      const glow = ctx.createRadialGradient(w * 0.34, h * 0.38, 0, w * 0.34, h * 0.38, w * 0.48);
      glow.addColorStop(0, `rgba(255, 197, 112, ${0.035 + 0.018 * Math.sin(time * 0.00065)})`);
      glow.addColorStop(1, "rgba(255, 197, 112, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      this.placeholderTexture.needsUpdate = true;
      return;
    }
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
    this.camera.position.copy(SEATS[seat]);
    this.recenter();
  }

  private faceScreen() {
    const position = this.camera.position;
    const depth = position.z - SCREEN_Z;
    this.manualYaw = Math.atan2(position.x, depth);
    this.manualPitch = Math.atan2(SCREEN_Y - position.y, Math.hypot(position.x, depth));
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
    this.faceScreen();
    if (this.sensorQuaternion) {
      const centeredView = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.manualPitch, this.manualYaw, 0, "YXZ"));
      this.sensorRecenter = centeredView.multiply(this.sensorQuaternion.clone().invert());
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

  isVideoTextureUpdating() {
    return Boolean(this.videoTexture && this.videoTexture.version > 0 && !this.lastError);
  }

  private fail(message: string) {
    if (this.lastError === message) return;
    this.lastError = message;
    this.onReport({ fps: null, error: message });
  }

  private frame = (time: number) => {
    if (!this.running || this.disposed) return;
    this.animationFrame = requestAnimationFrame(this.frame);
    if (this.sensorQuaternion && this.sensorRecenter) {
      this.camera.quaternion.copy(this.sensorQuaternion).premultiply(this.sensorRecenter);
    } else {
      this.camera.quaternion.setFromEuler(new THREE.Euler(this.manualPitch, this.manualYaw, 0, "YXZ"));
    }
    const placeholderInterval = this.quality === "low" ? 150 : this.quality === "medium" ? 100 : 66;
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
    this.artworkImage.onload = null;
    this.stop();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.resizeObserver.disconnect();
    this.videoTexture?.dispose();
    this.placeholderTexture.dispose();
    this.unitBox.dispose();
    this.roundedBox.dispose();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.renderer.dispose();
  }
}
