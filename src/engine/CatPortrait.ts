/**
 * CatPortrait — a small, self-animating rendering of one cat in a given state.
 * Used for the popup status cards and the Cat Studio cat list.
 */
import type { CatState } from '../shared/catStates';
import type { CatProfile } from '../shared/types';
import { ArticulatedCatRenderer } from './ArticulatedCatRenderer';
import { DEFAULT_POSE_CONTEXT, computePose } from './PoseLibrary';
import { clonePose, followPose, type Pose } from './Pose';
import { VerletTail } from './VerletTail';

export class CatPortrait {
  private renderer: ArticulatedCatRenderer;
  private tail: VerletTail;
  private pose: Pose;
  private time = 0;
  private stateTime = 0;
  private state: CatState = 'IDLE_SIT';
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    profile: CatProfile,
    private readonly facing: 1 | -1 = 1,
  ) {
    this.renderer = new ArticulatedCatRenderer(profile);
    this.pose = clonePose(computePose('IDLE_SIT', DEFAULT_POSE_CONTEXT));
    this.tail = new VerletTail(6, 10, 0, 0, Math.PI);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || this.canvas.width;
    const h = this.canvas.clientHeight || this.canvas.height;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  setProfile(p: CatProfile): void {
    this.renderer.setProfile(p);
  }

  setState(s: CatState): void {
    if (s !== this.state) {
      this.state = s;
      this.stateTime = 0;
    }
  }

  tick(dt: number): void {
    this.time += dt;
    this.stateTime += dt;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    const scale = h / 112;
    const target = computePose(this.state, { ...DEFAULT_POSE_CONTEXT, t: this.stateTime, progress: (this.stateTime % 2.4) / 2.4, gaitPhase: this.time * 1.4, sitting: true });
    // Gentle blinking.
    const blink = (this.time % 4.3) < 0.15 ? 1 - Math.sin(((this.time % 4.3) / 0.15) * Math.PI) : 1;
    if (target.eyeOpen > 0.2) target.eyeOpen *= blink;
    followPose(this.pose, target, 6, dt);
    const isLong = this.pose.roll > 0.2 || this.pose.thickTop > 15 || Math.abs(this.pose.shX - this.pose.hipX) > 46;
    const tr = { x: w * (isLong ? 0.56 : 0.5) - this.facing * 4 * scale, y: h * 0.9, flip: this.facing, scale };
    const skel = this.renderer.skeleton(this.pose, tr, this.time);
    const a = this.renderer.tailAnchorWorld(skel, this.pose);
    this.tail.segLen = 10.5 * scale * this.renderer.profile.morphology.tailLength * 0.85;
    this.tail.step(
      dt,
      a.x,
      a.y,
      { baseAngle: a.angle, curl: this.pose.tailCurl, waveAmp: this.pose.tailWave, waveFreq: this.pose.tailFreq, whip: this.pose.tailWhip, stiffness: this.pose.tailStiff, gravity: this.pose.tailGravity, damping: 0.94, maxBend: 1.15, handedness: this.facing },
      () => tr.y,
      2.4 * scale,
    );
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.renderer.draw(ctx, skel, this.pose, this.tail, scale, { time: this.time, grounded: true, groundY: tr.y });
  }
}
