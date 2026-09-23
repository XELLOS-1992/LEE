# Test audio

`two_speakers_ko.m4a` (34 s, two Korean speakers taking turns) is stitched
from sample utterances shipped with sherpa-onnx models:

- Speaker A: `test_wavs/0-3.wav` of `sherpa-onnx-zipformer-korean-2024-06-24`
  (sentences from the Zeroth-Korean corpus, CC BY 4.0)
- Speaker B: `test_wavs/ko.wav` of `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`

Expected turns: A 0.0 s, B 4.2 s, A 9.5 s, B 16.9 s, A 22.2 s, A 26.3 s, B 29.7 s.
