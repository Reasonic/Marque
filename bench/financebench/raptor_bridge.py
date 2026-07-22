"""
RAPTOR bridge — run the real RAPTOR (github.com/parthsarthi03/raptor) as a
retrieval system inside the Node FinanceBench harness.

RAPTOR is used for RETRIEVAL only: it builds its recursive summary tree and
returns the retrieved context for each question; the Node harness then answers
with the same gpt-4o and grades with the same grader, so the only variable vs.
`ours`/`baseline` is retrieval (exactly the head-to-head design).

Config, stated for the writeup: OpenAI text-embedding-3-small embeddings (same as
the vector baseline), gpt-4o-mini for cluster summaries (RAPTOR uses a cheap
summariser by design), 300-token leaf chunks, top-8 retrieval. We stub torch /
sentence-transformers / transformers / faiss — RAPTOR pulls them at import, but
none is used on the OpenAI-embeddings + tree-retrieval path.

I/O: JSON on stdin {text, questions:[{id,question}]} -> stdout
     {contexts:{id:text}, usage:{embed_tokens,sum_in,sum_out,calls}, error?}.
"""
import sys
import os
import json
import types

# Stub the heavy ML deps RAPTOR imports but that the OpenAI/tree path never uses.
# Return a fresh dummy class for ANY attribute, so library probes (e.g. scipy's
# `torch.Tensor` check) get a class rather than an AttributeError.
class _Stub(types.ModuleType):
    def __getattr__(self, name):
        return type(name, (), {})


for _n in ("torch", "faiss", "sentence_transformers", "transformers"):
    sys.modules[_n] = _Stub(_n)

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "raptor"))
from raptor import RetrievalAugmentation, RetrievalAugmentationConfig  # noqa: E402
from raptor import BaseSummarizationModel, BaseEmbeddingModel  # noqa: E402
from openai import OpenAI  # noqa: E402

USAGE = {"embed_tokens": 0, "sum_in": 0, "sum_out": 0, "calls": 0}
_client = OpenAI()


class OAEmbed(BaseEmbeddingModel):
    def __init__(self, model="text-embedding-3-small"):
        self.model = model

    def create_embedding(self, text):
        r = _client.embeddings.create(input=[text.replace("\n", " ")], model=self.model)
        USAGE["embed_tokens"] += r.usage.total_tokens
        return r.data[0].embedding


class OASummarize(BaseSummarizationModel):
    def __init__(self, model="gpt-4o-mini"):
        self.model = model

    def summarize(self, context, max_tokens=150):
        r = _client.chat.completions.create(
            model=self.model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content":
                       "Write a summary of the following, including as many key details as possible:\n" + context}],
        )
        USAGE["sum_in"] += r.usage.prompt_tokens
        USAGE["sum_out"] += r.usage.completion_tokens
        USAGE["calls"] += 1
        return r.choices[0].message.content


def main():
    req = json.load(sys.stdin)
    text = req["text"][:1_000_000]  # char safety cap
    emb = OAEmbed()
    cfg = RetrievalAugmentationConfig(
        embedding_model=emb,
        summarization_model=OASummarize(),
        tb_max_tokens=300,          # leaf chunk size
        tb_summarization_length=150,
        tr_top_k=8,                 # nodes returned as context
    )
    ra = RetrievalAugmentation(config=cfg)
    ra.add_documents(text)
    contexts = {}
    for q in req["questions"]:
        try:
            contexts[q["id"]] = ra.retrieve(
                q["question"], top_k=8, max_tokens=3500, return_layer_information=False)
        except Exception as e:  # one question failing must not lose the doc
            contexts[q["id"]] = ""
            USAGE.setdefault("errors", []).append(f"{q['id']}: {e}")
    json.dump({"contexts": contexts, "usage": USAGE}, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        json.dump({"error": str(e), "usage": USAGE}, sys.stdout)
        sys.exit(1)
