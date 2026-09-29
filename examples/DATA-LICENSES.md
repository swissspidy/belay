# Example data: sources and licenses

The `examples.jsonl` files are small samples (300 rows each) of public datasets. Each was
selected deterministically by `scripts/fetch-datasets.mjs` and relabeled or subset as described
below. Belay's own code is Apache-2.0. These data files keep their original licenses.

## `ticket-triage/examples.jsonl`

- **Source:** [Bitext Customer Support LLM Chatbot Training Dataset](https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset)
  by Bitext Innovations International, Inc.
- **License:** [Community Data License Agreement – Sharing, Version 1.0](https://cdla.dev/sharing-1-0/)
  (CDLA-Sharing-1.0). This subset is distributed under the same agreement.
- **Changes:** 60 `instruction` texts per team. The dataset's `category` is mapped to a team:
  - ACCOUNT → account
  - INVOICE, PAYMENT, REFUND → billing
  - ORDER, CANCEL → order
  - DELIVERY, SHIPPING → shipping
  - FEEDBACK → feedback

  The original `intent` is kept in `source`.

## `content-moderation/examples.jsonl`

- **Source:** [Civil Comments](https://huggingface.co/datasets/google/civil_comments) (test split),
  from Borkan et al., 2019, "Nuanced Metrics for Measuring Unintended Bias with Real Data for Text
  Classification".
- **License:** [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- **Changes:** comments of 20–400 characters. Labeled toxic when the rater `toxicity` fraction
  is ≥ 0.5 and non-toxic when ≤ 0.1; comments in between are excluded. 150 of each, and the
  original score is kept in `toxicity`.
- **Content warning:** contains offensive language.

## `intent-detection/examples.jsonl`

- **Source:** [MASSIVE](https://huggingface.co/datasets/AmazonScience/massive) (en-US test and
  validation splits, via [SetFit/amazon_massive_intent_en-US](https://huggingface.co/datasets/SetFit/amazon_massive_intent_en-US)),
  from FitzGerald et al., 2022, "MASSIVE: A 1M-Example Multilingual Natural Language Understanding
  Dataset with 51 Typologically-Diverse Languages". © Amazon.com, Inc.
- **License:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- **Changes:** 37–38 utterances for each of 8 intents.
