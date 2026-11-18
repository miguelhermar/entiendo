// AudioWorklet: downmix + downsample to 16 kHz, emit 100 ms Int16 frames.
class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.pos = 0;
    this.sum = 0;
    this.cnt = 0;
    this.frame = new Int16Array(1600);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const chans = input.length;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < chans; c++) s += input[c][i];
      this.sum += s / chans;
      this.cnt += 1;
      this.pos += 1;
      if (this.pos >= this.step) {
        this.pos -= this.step;
        let v = this.sum / this.cnt;
        this.sum = 0;
        this.cnt = 0;
        v = v < -1 ? -1 : v > 1 ? 1 : v;
        this.frame[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(1600);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm16k', Pcm16kProcessor);
