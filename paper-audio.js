/* Subtle procedural paper friction. This is not a recording of peeling paper. */
(() => {
  'use strict';

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const random = (low, high) => low + Math.random() * (high - low);

  class PaperAudio {
    constructor() {
      this.enabled = true;
      this.active = false;
      this.destroyed = false;
      this.context = null;
      this.voices = new Set();
      this.distance = 0;
      this.nextTravel = 7;
      this.lastProgress = 0;
      this.lastUpdate = 0;
      this.lastSound = -Infinity;
      this.quietTimer = null;
    }

    setEnabled(enabled) {
      this.enabled = Boolean(enabled);
      if (!this.enabled) this.cancel();
    }

    init() {
      if (this.context || this.destroyed) return;
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      this.context = new Context({ latencyHint: 'interactive' });
      const context = this.context;
      this.input = context.createBiquadFilter();
      this.input.type = 'highpass';
      this.input.frequency.value = 430;
      this.input.Q.value = .55;
      const lowpass = context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 2350;
      lowpass.Q.value = .55;
      const output = context.createGain();
      output.gain.value = .22;
      this.input.connect(lowpass).connect(output).connect(context.destination);

      // One continuous, non-periodic friction texture. Short excerpts use
      // varied offsets; nothing loops, crackles, pops, or resonates in a tone.
      this.texture = context.createBuffer(1, Math.ceil(context.sampleRate * .6), context.sampleRate);
      const samples = this.texture.getChannelData(0);
      let colour = 0;
      for (let i = 0; i < samples.length; i++) {
        colour = colour * .56 + (Math.random() * 2 - 1) * .44;
        samples[i] = colour;
      }
    }

    begin() {
      if (!this.enabled || this.destroyed) return;
      try {
        this.init();
        if (!this.context) return;
        if (this.context.state === 'suspended') this.context.resume().catch(() => {});
        clearTimeout(this.quietTimer);
        this.fade(.015);
        this.active = true;
        this.distance = 0;
        this.nextTravel = random(6, 12);
        this.lastProgress = 0;
        this.lastUpdate = performance.now();
        this.lastSound = -Infinity;
      } catch {
        this.active = false;
      }
    }

    // progress: 0..1. speed: CSS pixels/second, or omitted for estimation.
    update(progress, speed) {
      if (!this.active || !this.enabled || !this.context || this.context.state !== 'running') return;
      const now = performance.now();
      const next = clamp(Number(progress) || 0, 0, 1);
      const elapsed = clamp((now - this.lastUpdate) / 1000, .004, .10);
      const change = next - this.lastProgress;
      const travel = Math.abs(change) * 360;
      this.lastProgress = next;
      this.lastUpdate = now;
      if (travel < .1) return;
      this.distance = Math.min(24, this.distance + travel);
      if (this.distance >= this.nextTravel && now - this.lastSound >= 47) {
        const measured = travel / elapsed;
        const velocity = Number.isFinite(speed) ? Math.min(Math.abs(speed), measured * 1.5) : measured;
        const energy = clamp(Math.sqrt(velocity / 1000), .1, 1);
        this.rub((.022 + energy * .035) * (change > 0 ? 1 : .55), random(.028, .047));
        this.distance = 0;
        this.nextTravel = random(6, 12);
        this.lastSound = now;
      }
      clearTimeout(this.quietTimer);
      this.quietTimer = setTimeout(() => this.fade(.015), 55);
    }

    rub(amplitude, duration) {
      const context = this.context;
      if (!context || context.state !== 'running' || !this.enabled || this.destroyed || this.voices.size >= 3) return;
      const source = context.createBufferSource();
      source.buffer = this.texture;
      source.playbackRate.value = random(.98, 1.02);
      const gain = context.createGain();
      const start = context.currentTime;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(clamp(amplitude, 0, .06), start + .004);
      gain.gain.setValueAtTime(clamp(amplitude, 0, .06), start + duration * .55);
      gain.gain.linearRampToValueAtTime(0, start + duration);
      source.connect(gain).connect(this.input);
      const voice = { source, gain, stopping: false };
      this.voices.add(voice);
      source.onended = () => {
        source.disconnect(); gain.disconnect(); this.voices.delete(voice);
      };
      source.start(start, random(.02, .5), duration + .003);
    }

    release({ detached = false } = {}) {
      const wasActive = this.active;
      this.active = false;
      clearTimeout(this.quietTimer);
      this.fade(.012);
      if (wasActive && detached) this.rub(.036, .055);
    }

    fade(duration) {
      if (!this.context) return;
      const now = this.context.currentTime;
      for (const voice of this.voices) {
        if (voice.stopping) continue;
        voice.stopping = true;
        try {
          const gain = voice.gain.gain;
          if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now);
          else {
            const level = gain.value;
            gain.cancelScheduledValues(now); gain.setValueAtTime(level, now);
          }
          gain.linearRampToValueAtTime(0, now + duration);
          voice.source.stop(now + duration + .003);
        } catch { /* The short excerpt may already have ended. */ }
      }
    }

    cancel() {
      this.active = false;
      clearTimeout(this.quietTimer);
      this.fade(.015);
    }

    destroy() {
      this.cancel();
      this.destroyed = true;
      if (this.context) this.context.close().catch(() => {});
      this.context = null;
      this.texture = null;
    }
  }

  window.PaperAudio = PaperAudio;
})();
