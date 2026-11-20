export type SoundEffect = 'collect' | 'build' | 'enter' | 'alert' | 'click' | 'hurt';

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambience: GainNode | null = null;
  private effects: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private started = false;
  private volumes = { master: 0.42, ambience: 0.55, effects: 0.7 };

  async start(): Promise<void> {
    if (this.started) {
      await this.context?.resume();
      return;
    }
    const Constructor = window.AudioContext;
    this.context = new Constructor();
    this.master = this.context.createGain();
    this.ambience = this.context.createGain();
    this.effects = this.context.createGain();
    this.master.gain.value = this.volumes.master;
    this.ambience.gain.value = this.volumes.ambience;
    this.effects.gain.value = this.volumes.effects;
    this.ambience.connect(this.master);
    this.effects.connect(this.master);
    this.master.connect(this.context.destination);
    this.createAmbientBed();
    this.started = true;
    await this.context.resume();
  }

  setVolumes(master: number, ambience: number, effects: number): void {
    this.volumes = { master, ambience, effects };
    if (!this.context) return;
    this.master?.gain.setTargetAtTime(master, this.context.currentTime, 0.08);
    this.ambience?.gain.setTargetAtTime(ambience, this.context.currentTime, 0.08);
    this.effects?.gain.setTargetAtTime(effects, this.context.currentTime, 0.08);
  }

  setWeather(weather: string): void {
    if (!this.context || !this.rainGain) return;
    const target = weather === 'rain' ? 0.48 : weather === 'drizzle' ? 0.2 : weather === 'mist' ? 0.03 : 0.07;
    this.rainGain.gain.setTargetAtTime(target, this.context.currentTime, 0.6);
  }

  play(effect: SoundEffect): void {
    const context = this.context;
    const output = this.effects;
    if (!context || !output) return;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const config: Record<SoundEffect, { from: number; to: number; duration: number; type: OscillatorType; volume: number }> = {
      collect: { from: 640, to: 920, duration: 0.16, type: 'sine', volume: 0.12 },
      build: { from: 190, to: 340, duration: 0.26, type: 'triangle', volume: 0.15 },
      enter: { from: 260, to: 150, duration: 0.32, type: 'sine', volume: 0.1 },
      alert: { from: 410, to: 280, duration: 0.3, type: 'triangle', volume: 0.13 },
      click: { from: 520, to: 520, duration: 0.055, type: 'sine', volume: 0.04 },
      hurt: { from: 120, to: 70, duration: 0.22, type: 'sawtooth', volume: 0.09 },
    };
    const sound = config[effect];
    oscillator.type = sound.type;
    oscillator.frequency.setValueAtTime(sound.from, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, sound.to), now + sound.duration);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(sound.volume, now + 0.018);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + sound.duration);
    oscillator.connect(envelope);
    envelope.connect(output);
    oscillator.start(now);
    oscillator.stop(now + sound.duration + 0.02);
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.started = false;
  }

  private createAmbientBed(): void {
    const context = this.context!;
    const noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const channel = noiseBuffer.getChannelData(0);
    for (let i = 0; i < channel.length; i += 1) channel[i] = (Math.random() * 2 - 1) * (0.35 + Math.random() * 0.65);
    const noise = context.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 430;
    lowpass.Q.value = 0.2;
    const wind = context.createGain();
    wind.gain.value = 0.035;
    noise.connect(lowpass);
    lowpass.connect(wind);
    wind.connect(this.ambience!);
    noise.start();

    const rain = context.createGain();
    rain.gain.value = 0.07;
    const rainFilter = context.createBiquadFilter();
    rainFilter.type = 'highpass';
    rainFilter.frequency.value = 900;
    const rainNoise = context.createBufferSource();
    rainNoise.buffer = noiseBuffer;
    rainNoise.loop = true;
    rainNoise.connect(rainFilter);
    rainFilter.connect(rain);
    rain.connect(this.ambience!);
    rainNoise.start();
    this.rainGain = rain;

    const hum = context.createOscillator();
    const humGain = context.createGain();
    hum.type = 'sine';
    hum.frequency.value = 58;
    humGain.gain.value = 0.018;
    hum.connect(humGain);
    humGain.connect(this.ambience!);
    hum.start();
  }
}
