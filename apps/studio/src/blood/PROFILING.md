# GPU timing interpretation

`BloodGpuProfiler` is optional instrumentation. It requires a device requested with
`timestamp-query`, preallocates a bounded query/readback ring, and skips samples
when that ring is busy. Initialize with `await profiler.ready`; never wait for
profiling in a solver iteration. Call `frame.submit()` after submitting the
corresponding GPU command buffer. It reads results asynchronously and never
submits commands itself.

Each returned pass contains its observed timestamp duration and beginning/end
offsets in milliseconds, relative to the earliest measured beginning. The
timestamps describe **interval durations, not exclusive costs**. A backend can
report overlapping or cumulative intervals, so adding all observed durations can
substantially overstate GPU execution time. This occurred in actual Metal render
measurements during this optimization work.

Read these fields together:

- `timingModel` identifies non-overlapping intervals, overlapping intervals, or an
  unavailable measurement. An `ok` status means a valid timestamp sample was
  decoded; it does not imply additive phase costs.
- `overlappingPasses` counts intervals whose beginning precedes the maximum end of
  any preceding interval. Exactly touching timestamps are allowed.
- `gpuSpanMs` is the latest measured end minus the earliest measured beginning.
  This includes gaps within the measured span, but excludes CPU encoding,
  asynchronous readback, and queue latency before the first measured timestamp.
- `measuredPassMs` sums durations only when all measured intervals are
  non-overlapping. It is `null` when overlap is detected.
- `phaseMs` retains observed interval-duration sums by label for diagnosis.
  **Do not sum these fields to estimate GPU time, or interpret them as exclusive
  phase costs when intervals overlap.** The individual `passes` endpoints permit
  inspection of the actual interval pattern.
- `partial` means the configured pass capacity was exceeded; the report covers
  only recorded passes. Invalid timestamp deltas or an unrepresentable total
  timestamp span discard the sample.

For example, eight intervals starting together and ending after 0.9, 1.3, 11, 20,
29, 39, 39, and 40 ms have a 40 ms measured span and seven overlapping intervals.
Their 180.2 ms duration sum is not a GPU execution time. This profiler reports
`gpuSpanMs: 40`, `measuredPassMs: null`, and
`timingModel: "overlapping-pass-intervals"` for that case.

Keep independent wall-time measurements and actual video frame rates when
assessing user-visible performance. Timestamp resolution is implementation
dependent; zero-duration quantized intervals remain valid. Counters may reset.
See the [Chrome WebGPU timestamp-query documentation](https://developer.chrome.com/blog/new-in-webgpu-121#timestamp_queries_in_compute_and_render_passes)
for the standard pass timestamp API and these measurement caveats.
