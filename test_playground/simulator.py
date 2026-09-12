"""FutureTransit: deterministic, dependency-free reservation experiment (seconds)."""
from __future__ import annotations

import argparse
import bisect
import csv
import heapq
import json
import math
from pathlib import Path
import random
import statistics
import time


def edge_key(a, b):
    return "edge:" + "--".join(sorted((a, b)))


class Network:
    def __init__(self):
        self.nodes, self.graph, self.edges = {}, {}, []
        for i in range(5):
            angle = -math.pi / 2 + i * 2 * math.pi / 5
            for prefix, radius, kind in (("J", 125, "merge/split"), ("S", 210, "branch")):
                self.add_node(f"{prefix}{i}", 440 + radius * math.cos(angle),
                              365 + radius * math.sin(angle), kind)
            for k, delta in enumerate((-.17, .17)):
                a = angle + delta
                self.add_node(f"B{2*i+k:02}", 440 + 310 * math.cos(a),
                              365 + 310 * math.sin(a), "building")
                self.link(f"B{2*i+k:02}", f"S{i}", 4, "access")
            self.link(f"S{i}", f"J{i}", 5, "branch")
        for i in range(5):
            self.link(f"J{i}", f"J{(i+1)%5}", 8, "trunk")
        self.link("J0", "J2", 10, "trunk")

    def add_node(self, name, x, y, kind):
        self.nodes[name] = dict(id=name, x=round(x, 2), y=round(y, 2), kind=kind)
        self.graph[name] = []

    def link(self, a, b, duration, kind):
        self.graph[a].append((b, duration))
        self.graph[b].append((a, duration))
        self.edges.append(dict(a=a, b=b, duration=duration, kind=kind))

    def duration(self, a, b):
        return next(d for n, d in self.graph[a] if n == b)

    def route(self, origin, destination):
        """Access hierarchy -> core-only Dijkstra -> destination access hierarchy."""
        if origin == destination:
            raise ValueError("Origin and destination must differ")
        a, b = int(origin[1:]) // 2, int(destination[1:]) // 2
        if a == b:
            return [origin, f"S{a}", destination]
        start, goal = f"J{a}", f"J{b}"
        queue, seen = [(0, [start])], set()
        while queue:
            cost, path = heapq.heappop(queue)
            node = path[-1]
            if node in seen:
                continue
            seen.add(node)
            if node == goal:
                return [origin, f"S{a}"] + path + [f"S{b}", destination]
            for nxt, duration in self.graph[node]:
                if nxt.startswith("J") and nxt not in seen:
                    heapq.heappush(queue, (cost + duration + 1, path + [nxt]))
        raise ValueError("No core route")

    def itinerary(self, path):
        segments, offset = [], 0
        for i, node in enumerate(path):
            duration = 2 if node.startswith("B") else 1
            segments.append(dict(kind="node", a=node, b=node, start=offset, end=offset+duration))
            offset += duration
            if i + 1 < len(path):
                nxt = path[i+1]
                duration = self.duration(node, nxt)
                segments.append(dict(kind="edge", a=node, b=nxt, start=offset, end=offset+duration))
                offset += duration
        return segments


def resource(segment):
    return "node:" + segment["a"] if segment["kind"] == "node" else edge_key(segment["a"], segment["b"])


class Scheduler:
    def __init__(self, network, clearance=1):
        self.network, self.clearance = network, clearance
        self.calendar = {}
        self.probes = 0

    def reserve(self, origin, destination, ready, trip_id):
        path = self.network.route(origin, destination)
        template = self.network.itinerary(path)
        departure = ready
        # Rejected proposals do not mutate calendars. No partial reservation/hold-and-wait.
        while True:
            jump = departure
            for seg in template:
                bookings = self.calendar.get(resource(seg), [])
                start, end = departure + seg["start"], departure + seg["end"] + self.clearance
                index = max(0, bisect.bisect_left(bookings, (start,)) - 1)
                for left, right, _ in bookings[index:]:
                    self.probes += 1
                    if left >= end:
                        break
                    if start < right and left < end:
                        jump = max(jump, right - seg["start"])
            if jump == departure:
                break
            departure = jump
        segments = [dict(s, start=s["start"]+departure, end=s["end"]+departure) for s in template]
        for seg in segments:
            bookings = self.calendar.setdefault(resource(seg), [])
            bisect.insort(bookings, (seg["start"], seg["end"]+self.clearance, trip_id))
        return dict(id=trip_id, origin=origin, destination=destination, ready=ready,
                    departure=departure, arrival=segments[-1]["end"], wait=departure-ready,
                    path=path, segments=segments)


def audit(network, trips, fleet, clearance):
    """Reconstruct space-time occupancy from trajectories, without consulting calendars.

    Integer ticks are exact for this discrete model, including one-second clearance.
    Also checks route continuity, vehicle reuse, request order and completion.
    """
    physical, guarded = {}, {}
    conflicts, clearance_conflicts, errors = [], [], []
    vehicles = {}
    for trip in trips:
        segments = trip["segments"]
        if trip["departure"] < trip["ready"] or segments[0]["a"] != trip["origin"] or segments[-1]["b"] != trip["destination"]:
            errors.append(f"Invalid endpoints/release: {trip['id']}")
        if [s["a"] for s in segments if s["kind"] == "node"] != trip["path"]:
            errors.append(f"Path mismatch: {trip['id']}")
        for index, seg in enumerate(segments):
            if index and (segments[index-1]["end"] != seg["start"] or segments[index-1]["b"] != seg["a"]):
                errors.append(f"Discontinuous trip: {trip['id']}")
            expected = network.duration(seg["a"], seg["b"]) if seg["kind"] == "edge" else (2 if seg["a"].startswith("B") else 1)
            if seg["end"] - seg["start"] != expected:
                errors.append(f"Invalid duration: {trip['id']}")
            # Independent resource naming for verifier, rather than scheduler lookup.
            key = ("node", seg["a"]) if seg["kind"] == "node" else ("edge", *sorted((seg["a"], seg["b"])))
            for tick in range(seg["start"], seg["end"] + clearance):
                slot = (key, tick)
                if slot in guarded and guarded[slot] != trip["id"]:
                    clearance_conflicts.append((slot, guarded[slot], trip["id"]))
                guarded[slot] = trip["id"]
                if tick < seg["end"]:
                    if slot in physical and physical[slot] != trip["id"]:
                        conflicts.append((slot, physical[slot], trip["id"]))
                    physical[slot] = trip["id"]
        if segments[0]["start"] != trip["departure"] or segments[-1]["end"] != trip["arrival"]:
            errors.append(f"Invalid completion time: {trip['id']}")
        vehicles.setdefault(trip["pod"], []).append(trip)
    for pod, journeys in vehicles.items():
        journeys.sort(key=lambda t: t["ready"])
        for prev, nxt in zip(journeys, journeys[1:]):
            if nxt["ready"] < prev["arrival"] or nxt["origin"] != prev["destination"]:
                errors.append(f"Vehicle overlap/teleport: {pod}")
    return dict(conflict_ticks=len(conflicts), clearance_violation_ticks=len(clearance_conflicts),
                trajectory_errors=errors, vehicles_seen=len(vehicles),
                fleet_valid=len(vehicles) == fleet)


def destination_for(mode, origin, rng, pod):
    choices = [f"B{i:02}" for i in range(10) if f"B{i:02}" != origin]
    if mode == "bottleneck":
        return "B00" if origin != "B00" else f"B{2 + pod % 8:02}"
    if mode == "opposing":
        return "B06" if origin == "B00" else "B00"
    if mode == "cycle":
        return f"B{(int(origin[1:])+2)%10:02}"
    return rng.choice(choices)


def simulate(mode="random", fleet=30, rounds=1, seed=7, clearance=1):
    if fleet < 1 or rounds < 1 or clearance < 0:
        raise ValueError("fleet/rounds must be positive and clearance nonnegative")
    started = time.perf_counter()
    network, rng = Network(), random.Random(seed)
    scheduler = Scheduler(network, clearance)
    queue = []
    for pod in range(fleet):
        origin = ("B00" if pod % 2 == 0 else "B06") if mode == "opposing" else f"B{pod%10:02}"
        heapq.heappush(queue, (0, pod, 0, origin))
    trips = []
    while queue:
        ready, pod, run, origin = heapq.heappop(queue)
        destination = destination_for(mode, origin, rng, pod)
        trip = scheduler.reserve(origin, destination, ready, len(trips))
        trip.update(pod=pod, run=run)
        trips.append(trip)
        if run+1 < rounds:
            heapq.heappush(queue, (trip["arrival"]+3, pod, run+1, destination))
    scheduling_ms = (time.perf_counter()-started)*1000
    verified = audit(network, trips, fleet, clearance)
    waits = sorted(t["wait"] for t in trips)
    end = max(t["arrival"] for t in trips)
    metrics = dict(scenario=mode, seed=seed, fleet=fleet, requested_trips=fleet*rounds,
                   completed_trips=len(trips), makespan_s=end,
                   throughput_trips_min=round(len(trips)*60/end, 3),
                   mean_wait_s=round(statistics.mean(waits), 3),
                   p95_wait_s=waits[math.ceil(.95*len(waits))-1], max_wait_s=max(waits),
                   mean_trip_s=round(statistics.mean(t["arrival"]-t["ready"] for t in trips), 3),
                   unfinished_trips=fleet*rounds-len(trips),
                   in_network_wait_s=0, scheduling_ms=round(scheduling_ms, 3),
                   reservation_probes=scheduler.probes, **verified)
    metrics["passed"] = (not verified["conflict_ticks"] and not verified["clearance_violation_ticks"]
                         and not verified["trajectory_errors"] and verified["fleet_valid"]
                         and metrics["unfinished_trips"] == 0)
    return dict(metrics=metrics, clearance_s=clearance, nodes=list(network.nodes.values()),
                edges=network.edges, trips=trips)


def write_run(result, output):
    output.mkdir(parents=True, exist_ok=True)
    (output/"run.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    (output/"metrics.json").write_text(json.dumps(result["metrics"], indent=2), encoding="utf-8")
    with (output/"trips.csv").open("w", newline="", encoding="utf-8") as handle:
        fields = ["id", "pod", "origin", "destination", "ready", "departure", "arrival", "wait", "path"]
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(dict(t, path=" -> ".join(t["path"])) for t in result["trips"])
    events = []
    for trip in result["trips"]:
        name = f"Pod {trip['pod']:02} trip {trip['id']:03}"
        events.append((trip["ready"], f"{name} REQUEST {trip['origin']} -> {trip['destination']}"))
        events.append((trip["departure"], f"{name} DEPART wait={trip['wait']}s"))
        for seg in trip["segments"]:
            if seg["kind"] == "edge":
                events.append((seg["start"], f"{name} MOVE {seg['a']} -> {seg['b']} until={seg['end']}"))
        events.append((trip["arrival"], f"{name} ARRIVE {trip['destination']}"))
    (output/"events.log").write_text("\n".join(f"t={t:6}s {event}" for t, event in sorted(events))+"\n", encoding="utf-8")
    template = Path(__file__).with_name("replay.html").read_text(encoding="utf-8")
    (output/"replay.html").write_text(template.replace("/*__RUN_DATA__*/ null", json.dumps(result, ensure_ascii=False)), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=["random", "bottleneck", "opposing", "cycle"], default="random")
    parser.add_argument("--fleet", type=int, default=30)
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--clearance", type=int, default=1)
    parser.add_argument("--output", type=Path, default=Path("results/demo"))
    args = parser.parse_args()
    result = simulate(args.scenario, args.fleet, args.rounds, args.seed, args.clearance)
    write_run(result, args.output)
    print(json.dumps(result["metrics"], ensure_ascii=False, indent=2))
    if not result["metrics"]["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
