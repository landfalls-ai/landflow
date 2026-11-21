# Notice: code adapted from Supermemory's memory-graph

Three files in this folder are adapted from the `memory-graph` package of [supermemory](https://github.com/supermemoryai/supermemory)
(`packages/memory-graph`, commit `9547bd0f`), which is licensed under the MIT licence. Each carries a header naming its source.

| File here | Source file | What changed |
|---|---|---|
| `simulation.ts` | `src/canvas/simulation.ts` | `d3-force` forces retuned for facts around subjects; document clustering removed; stepped by the caller with a 2 s budget and paused while the tab is hidden |
| `viewport.ts` | `src/canvas/viewport.ts` | a keyboard handler (`applyKey`) added; a fit zooms in up to 2x instead of 1x |
| `hit-test.ts` | `src/canvas/hit-test.ts` | subjects (squares) and facts (circles) replace documents and memories |

`renderer.ts`, `graph-view.tsx`, `legend.tsx`, `popover.tsx`, `graph-list.tsx`, `merge.ts` and `types.ts` are written for Landflow
after the structure of Supermemory's renderer, canvas component, legend and hover popover; none of their drawing or React code is copied.

## The licence

```
MIT License

Copyright (c) 2025 supermemory

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
