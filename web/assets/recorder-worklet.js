// Runs on the audio thread: mixes to mono, resamples to 16 kHz, emits Int16 PCM
// in ~100 ms packets plus a level reading for the meter.
class PCMRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = (options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.target;
    this.pos = 0;          // fractional read position into the carried input
    this.carry = new Float32Array(0);
    this.out = new Int16Array(1600);
    this.n = 0;
    this.paused = false;
    this.peak = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'pause') this.paused = true;
      else if (e.data === 'resume') this.paused = false;
      else if (e.data === 'flush') this.flush();
    };
  }

  flush() {
    if (this.n > 0) {
      const buf = this.out.slice(0, this.n).buffer;
      this.port.postMessage({ pcm: buf, level: this.peak }, [buf]);
      this.n = 0;
      this.peak = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const len = input[0].length;
    const mono = new Float32Array(len);
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < len; i++) mono[i] += ch[i] / input.length;
    }
    if (this.paused) {
      this.port.postMessage({ level: 0, paused: true });
      return true;
    }
    // Concatenate leftovers from the previous block.
    const data = new Float32Array(this.carry.length + len);
    data.set(this.carry, 0);
    data.set(mono, this.carry.length);
    const r = this.ratio;
    let pos = this.pos;
    while (pos + r <= data.length) {
      // Box filter over the source span = cheap anti-aliasing for downsampling.
      const a = Math.floor(pos), b = Math.min(data.length, Math.floor(pos + r));
      let sum = 0;
      for (let i = a; i < b; i++) sum += data[i];
      const v = b > a ? sum / (b - a) : data[a];
      const abs = Math.abs(v);
      if (abs > this.peak) this.peak = abs;
      const s = Math.max(-1, Math.min(1, v));
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.out.length) this.flush();
      pos += r;
    }
    const used = Math.floor(pos);
    this.carry = data.slice(used);
    this.pos = pos - used;
    return true;
  }
}

registerProcessor('pcm-recorder', PCMRecorder);
