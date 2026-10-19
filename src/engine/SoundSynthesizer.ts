/**
 * SoundSynthesizer — every sound is synthesised live with the Web Audio API.
 * Zero audio files, zero network. The AudioContext is created lazily on the
 * first user gesture (browser autoplay policy) and never before.
 *
 *  • purr   — band-passed noise amplitude-modulated at ~25 Hz + a 50 Hz hum
 *  • meow   — sawtooth source through two moving formant filters ("mee-ow")
 *  • trill  — chirrupy rolled-R greeting (vibrato FM)
 *  • chirp  — short hunting chatter
 *  • mrrp   — tiny questioning blip when booped (and the soft chirrup on pickup)
 *  • crunch — kibble being chewed (short band-passed noise clicks)
 *  • lap    — a tongue lapping water
 *  • pour   — kibble rattling into the bowl / water filling it
 */
import { clamp } from '../shared/math';

interface PurrVoice {
  gain: GainNode;
  stop: () => void;
}

export class SoundSynthesizer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private purrs = new Map<string, PurrVoice>();
  private volume = 0.45;
  private enabled = true;
  private lastVoice = 0;

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) for (const id of [...this.purrs.keys()]) this.purr(id, false);
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
  }

  get active(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Must be called from a user-gesture handler the first time. */
  unlock(): void {
    if (!this.enabled) return;
    try {
      if (!this.ctx) {
        const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
        if (!Ctor) return;
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.ratio.value = 6;
        this.master.connect(comp).connect(this.ctx.destination);
        this.noise = this.makeNoise(2);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  dispose(): void {
    for (const id of [...this.purrs.keys()]) this.purr(id, false);
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  private ready(): AudioContext | null {
    if (!this.enabled || !this.ctx || !this.master || this.ctx.state !== 'running') return null;
    return this.ctx;
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965809;
      d[i] = (b0 + b1 + w * 0.1848) * 0.35;
    }
    return buf;
  }

  /** Starts or stops a looping purr for one cat. */
  purr(catId: string, on: boolean, intensity = 1): void {
    const existing = this.purrs.get(catId);
    if (!on) {
      if (existing) {
        existing.stop();
        this.purrs.delete(catId);
      }
      return;
    }
    const ctx = this.ready();
    if (!ctx || !this.master || !this.noise) return;
    if (existing) {
      existing.gain.gain.setTargetAtTime(0.22 * intensity, ctx.currentTime, 0.2);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 150 + Math.random() * 40;
    bp.Q.value = 0.9;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const am = ctx.createGain();
    am.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 23 + Math.random() * 5;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.48;
    lfo.connect(lfoDepth).connect(am.gain);
    // breathing cycle (inhale/exhale purr)
    const breath = ctx.createOscillator();
    breath.frequency.value = 0.42;
    const breathDepth = ctx.createGain();
    breathDepth.gain.value = 0.12;
    breath.connect(breathDepth).connect(am.gain);
    const hum = ctx.createOscillator();
    hum.type = 'triangle';
    hum.frequency.value = 48;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.06;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.gain.setTargetAtTime(0.22 * intensity, ctx.currentTime, 0.35);
    src.connect(bp).connect(lp).connect(am).connect(out);
    hum.connect(humGain).connect(am);
    out.connect(this.master);
    src.start();
    lfo.start();
    breath.start();
    hum.start();
    const stop = () => {
      const t = ctx.currentTime;
      out.gain.setTargetAtTime(0, t, 0.25);
      for (const n of [src, lfo, breath, hum]) n.stop(t + 1.2);
    };
    this.purrs.set(catId, { gain: out, stop });
  }

  private voiceGate(): boolean {
    const now = performance.now();
    if (now - this.lastVoice < 350) return false;
    this.lastVoice = now;
    return true;
  }

  meow(pitch = 1, length = 0.62): void {
    const ctx = this.ready();
    if (!ctx || !this.master || !this.voiceGate()) return;
    const t = ctx.currentTime;
    const dur = length;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const f0 = 520 * pitch;
    osc.frequency.setValueAtTime(f0 * 0.85, t);
    osc.frequency.linearRampToValueAtTime(f0 * 1.35, t + dur * 0.35);
    osc.frequency.linearRampToValueAtTime(f0 * 0.75, t + dur);
    const vib = ctx.createOscillator();
    vib.frequency.value = 6;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = f0 * 0.015;
    vib.connect(vibDepth).connect(osc.frequency);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.Q.value = 6;
    f1.frequency.setValueAtTime(650, t);
    f1.frequency.linearRampToValueAtTime(1100, t + dur * 0.4);
    f1.frequency.linearRampToValueAtTime(700, t + dur);
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.Q.value = 8;
    f2.frequency.setValueAtTime(1800, t);
    f2.frequency.linearRampToValueAtTime(2300, t + dur * 0.3);
    f2.frequency.linearRampToValueAtTime(1300, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.06);
    g.gain.setValueAtTime(0.5, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const mix = ctx.createGain();
    mix.gain.value = 0.9;
    osc.connect(f1).connect(g);
    osc.connect(f2).connect(mix).connect(g);
    g.connect(this.master);
    osc.start(t);
    vib.start(t);
    osc.stop(t + dur + 0.05);
    vib.stop(t + dur + 0.05);
  }

  trill(pitch = 1): void {
    const ctx = this.ready();
    if (!ctx || !this.master || !this.voiceGate()) return;
    const t = ctx.currentTime;
    const dur = 0.42;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(560 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(880 * pitch, t + dur);
    const fm = ctx.createOscillator();
    fm.frequency.value = 26;
    const fmDepth = ctx.createGain();
    fmDepth.gain.value = 90 * pitch;
    fm.connect(fmDepth).connect(osc.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    fm.start(t);
    osc.stop(t + dur + 0.05);
    fm.stop(t + dur + 0.05);
  }

  chirp(): void {
    const ctx = this.ready();
    if (!ctx || !this.master || !this.voiceGate()) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const s = t + i * 0.09;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(1300, s);
      osc.frequency.exponentialRampToValueAtTime(900, s + 0.06);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500;
      bp.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.12, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.07);
      osc.connect(bp).connect(g).connect(this.master);
      osc.start(s);
      osc.stop(s + 0.08);
    }
  }

  mrrp(pitch = 1): void {
    const ctx = this.ready();
    if (!ctx || !this.master || !this.voiceGate()) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(380 * pitch, t);
    osc.frequency.linearRampToValueAtTime(620 * pitch, t + 0.16);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(f).connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.22);
  }

  /** One bite of kibble: two or three short, bright noise clicks. */
  crunch(): void {
    const ctx = this.ready();
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime;
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) this.grain(ctx, t + i * 0.045 + Math.random() * 0.02, 1800 + Math.random() * 1600, 2.5, 0.05 + Math.random() * 0.04, 0.035);
  }

  /** A single lap of water: a tiny wet "plip". */
  lap(): void {
    const ctx = this.ready();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(950 + Math.random() * 200, t);
    osc.frequency.exponentialRampToValueAtTime(520, t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  /** Refill: kibble rattling into the bowl, or water pouring in. */
  pour(kind: 'food' | 'water'): void {
    const ctx = this.ready();
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime;
    if (kind === 'food') {
      for (let i = 0; i < 26; i++) {
        const at = t + Math.pow(Math.random(), 1.4) * 0.7;
        this.grain(ctx, at, 2200 + Math.random() * 2400, 4, 0.03 + Math.random() * 0.05, 0.03);
      }
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.linearRampToValueAtTime(1500, t + 0.8);
    const gurgle = ctx.createOscillator();
    gurgle.frequency.value = 11;
    const gd = ctx.createGain();
    gd.gain.value = 260;
    gurgle.connect(gd).connect(bp.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.08);
    g.gain.setValueAtTime(0.22, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    gurgle.start(t);
    src.stop(t + 1);
    gurgle.stop(t + 1);
  }

  private grain(ctx: AudioContext, at: number, freq: number, q: number, gain: number, dur: number): void {
    if (!this.master || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(at, Math.random() * 1.5);
    src.stop(at + dur + 0.01);
  }
}
