"""Run reproducible scenarios with independent trajectory audits."""
import json
from pathlib import Path

from simulator import simulate, write_run


def main():
    results = []
    for mode, rounds in [("random", 1), ("bottleneck", 1), ("opposing", 1),
                         ("cycle", 1), ("random", 20), ("bottleneck", 20),
                         ("opposing", 20), ("cycle", 20)]:
        result = simulate(mode, rounds=rounds, seed=7)
        write_run(result, Path("results") / f"{mode}-{rounds}")
        results.append(result["metrics"])
        m = result["metrics"]
        print(f"{mode:12} {m['completed_trips']:4} trips | {m['throughput_trips_min']:6.2f}/min | "
              f"wait mean/p95/max {m['mean_wait_s']:7.2f}/{m['p95_wait_s']:4}/{m['max_wait_s']:4}s | "
              f"conflicts {m['conflict_ticks']} | unfinished {m['unfinished_trips']} | "
              f"schedule {m['scheduling_ms']:.1f}ms")
    Path("results/benchmark.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    if not all(m["passed"] for m in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
