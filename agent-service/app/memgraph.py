"""Graph recall maths (docs/memory-v3.html §5.4–5.5), pure functions; app/mem.py feeds them.

strength   ACT-R base-level activation of a fact from the times it was used (learned, restated, recalled on
           request), plus the gate's p as a prior, as a probability of recall:
               B = ln Σ (t − t_j)^−d,  A = B + γ·logit(p),  P = σ((A − τ)/s)      d = 0.5, τ = −1, s = 0.4, γ = 0.5
links      PPMI between entities over episodes: w_ab = max(0, ln(n_ab·N / (n_a·n_b)))
spread     Personalized PageRank from the entities a moment names: π ← α·s + (1 − α)·Wπ, α = 0.15, 20 steps
rank       R = 0.5·similarity + 0.25·(best π among the entities a fact mentions) + 0.25·strength
"""
import math
from datetime import datetime

D, TAU, S, GAMMA = 0.5, -1.0, 0.4, 0.5
ALPHA, STEPS = 0.15, 20
W_SIM, W_GRAPH, W_STRENGTH = 0.5, 0.25, 0.25
FADE_BELOW = 0.2  # a tentative fact whose strength falls under this fades (single use: about 2 to 3 weeks)


def strength(uses: list[datetime], now: datetime, salience: float | None = None) -> float:
    if not uses:
        return 0.0
    b = math.log(sum(max((now - u).total_seconds() / 86400, 1 / 24) ** -D for u in uses))
    p = min(max(0.8 if salience is None else salience, 1e-3), 1 - 1e-3)
    a = b + GAMMA * math.log(p / (1 - p))
    return 1 / (1 + math.exp(-(a - TAU) / S))


def links(episodes: list[set[str]]) -> dict[str, dict[str, float]]:
    """PPMI adjacency between the entities that came up in the same episodes."""
    n: dict[str, int] = {}
    pairs: dict[tuple[str, str], int] = {}
    eps = [e for e in episodes if e]
    for es in eps:
        for a in es:
            n[a] = n.get(a, 0) + 1
        s = sorted(es)
        for i, a in enumerate(s):
            for b in s[i + 1:]:
                pairs[(a, b)] = pairs.get((a, b), 0) + 1
    adj: dict[str, dict[str, float]] = {}
    for (a, b), nab in pairs.items():
        w = math.log(nab * len(eps) / (n[a] * n[b]))
        if w > 0:
            adj.setdefault(a, {})[b] = w
            adj.setdefault(b, {})[a] = w
    return adj


def spread(adj: dict[str, dict[str, float]], seeds: set[str], steps: int = STEPS) -> dict[str, float]:
    """Personalized PageRank from the seeds: how strongly each entity is linked to what the moment is about."""
    seeds = {s for s in seeds if s}
    if not seeds:
        return {}
    s0 = {x: 1 / len(seeds) for x in seeds}
    pi = dict(s0)
    deg = {a: sum(ws.values()) for a, ws in adj.items()}
    for _ in range(steps):
        nxt = {x: ALPHA * v for x, v in s0.items()}
        for j, v in pi.items():
            if not deg.get(j):
                nxt[j] = nxt.get(j, 0) + (1 - ALPHA) * v  # nowhere to go: it stays
                continue
            for i, w in adj[j].items():
                nxt[i] = nxt.get(i, 0) + (1 - ALPHA) * v * w / deg[j]
        pi = nxt
    return pi


def rank(sim: float, graph: float, strong: float) -> float:
    return W_SIM * sim + W_GRAPH * graph + W_STRENGTH * strong


if __name__ == "__main__":  # python -m app.memgraph: the maths, checked
    from datetime import UTC, timedelta
    now = datetime(2026, 10, 18, tzinfo=UTC)
    fresh, month = strength([now - timedelta(hours=2)], now), strength([now - timedelta(days=30)], now)
    used = strength([now - timedelta(days=30), now - timedelta(days=20), now - timedelta(days=5)], now)
    assert fresh > used > month, (fresh, used, month)  # use strengthens, time weakens (spacing)
    unsure = lambda days: strength([now - timedelta(days=days)], now, 0.35)  # noqa: E731
    assert unsure(5) > FADE_BELOW > unsure(30)  # a trivial unsure fact fades within weeks, not days
    adj = links([{"ananya", "freshworks"}, {"freshworks", "pitch"}, {"ananya", "freshworks"}, {"dev", "tubelight"}])
    pi = spread(adj, {"ananya"})
    assert pi["freshworks"] > pi["pitch"] > 0 and "dev" not in pi  # two hops away is reached, unlinked isn't
    assert abs(sum(pi.values()) - 1) < 1e-9
    print("ok", round(fresh, 3), round(used, 3), round(month, 3), {k: round(v, 3) for k, v in pi.items()})
