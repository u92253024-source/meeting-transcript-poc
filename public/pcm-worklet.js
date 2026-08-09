class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.targetSamples = 2048;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, channel[index]));
      this.pending.push(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
    }
    if (this.pending.length >= this.targetSamples) {
      const samples = new Int16Array(this.pending.splice(0, this.targetSamples));
      this.port.postMessage(samples.buffer, [samples.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
