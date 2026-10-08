# @swissspidy/belay-web

On-device runners for [Belay](https://github.com/swissspidy/belay#readme), built on the
browser's built-in AI:

- `classifierApi()`: classification with Chrome's Classifier API. The calibrated probability of
  the returned label is the confidence.
- `promptApi()`: structured (JSON) generation with Chrome's Prompt API.
- `classifierJudge()`: scores a generated answer with a Classifier API question ("is this answer
  correct?"), so generation tasks get a confidence too.

They work with the native APIs and with polyfills that define the same globals, such as the
[WebAI Studio extension](https://web-ai.studio/playgrounds/classifier).

> **Status:** experimental (0.x). The built-in AI APIs are still behind flags in Chrome, and this
> API may change between minor versions.

## Install

```sh
npm install @swissspidy/belay-core @swissspidy/belay-web
```

## Usage

```ts
import { task, fetchAdapter } from '@swissspidy/belay-core';
import { classifierApi } from '@swissspidy/belay-web';

const moderate = task({
  name: 'moderation',
  schema: { type: 'binary', prompt: 'Is this comment abusive?' },
  local: classifierApi(),
  cloud: fetchAdapter({ url: '/api/belay' }),
  threshold: 0.8,
});

// run() never downloads a model; call prepare() from a user gesture to download it.
button.onclick = () => moderate.prepare({ onProgress: (p) => (progress.value = p) });
```

See the [project README](https://github.com/swissspidy/belay#readme) for generation tasks, model
downloads and the full API.

## License

Apache-2.0
