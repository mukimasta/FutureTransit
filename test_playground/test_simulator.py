import copy
import unittest

from simulator import Network, Scheduler, audit, simulate


class SchedulingTests(unittest.TestCase):
    def test_all_building_pairs_connected_and_hierarchical(self):
        network = Network()
        for a in range(10):
            for b in range(10):
                if a == b:
                    continue
                path = network.route(f"B{a:02}", f"B{b:02}")
                self.assertEqual(len(path), len(set(path)))
                self.assertFalse(any(n.startswith("B") for n in path[1:-1]))
                if a//2 == b//2:
                    self.assertEqual(len(path), 3)
                else:
                    self.assertTrue(all(n.startswith("J") for n in path[2:-2]))
                for start, end in zip(path, path[1:]):
                    self.assertGreater(network.duration(start, end), 0)

    def test_half_open_boundary_and_clearance(self):
        net = Network()
        scheduler = Scheduler(net, clearance=1)
        first = scheduler.reserve("B00", "B01", 0, 0)
        second = scheduler.reserve("B00", "B01", 0, 1)
        # Access edge is occupied for four seconds plus one clearance second.
        self.assertEqual(second["departure"], 5)
        first["pod"], second["pod"] = 0, 1
        self.assertEqual(audit(net, [first, second], 2, 1)["clearance_violation_ticks"], 0)

    def test_auditor_catches_injected_same_resource_collision(self):
        result = simulate(fleet=1)
        duplicate = copy.deepcopy(result["trips"][0])
        duplicate.update(id=1, pod=1)
        check = audit(Network(), result["trips"]+[duplicate], 2, 1)
        self.assertGreater(check["conflict_ticks"], 0)

    def test_auditor_catches_opposite_direction_collision(self):
        net = Network()
        first = Scheduler(net).reserve("B00", "B01", 0, 0)
        second = Scheduler(net).reserve("B01", "B00", 0, 1)
        # Shift reverse trip so its inbound access edge meets first's outbound edge.
        for seg in second["segments"]:
            seg["start"] += 5
            seg["end"] += 5
        second["departure"] += 5
        second["arrival"] += 5
        first["pod"], second["pod"] = 0, 1
        check = audit(net, [first, second], 2, 1)
        self.assertGreater(check["conflict_ticks"], 0)

    def test_auditor_catches_vehicle_teleport(self):
        result = simulate(fleet=1, rounds=2)
        result["trips"][1]["origin"] = "B99"
        self.assertTrue(audit(Network(), result["trips"], 1, 1)["trajectory_errors"])

    def test_no_partial_bookings_left_after_retry(self):
        scheduler = Scheduler(Network())
        trips = [scheduler.reserve("B00", "B08", 0, i) for i in range(12)]
        self.assertEqual(sum(len(v) for v in scheduler.calendar.values()),
                         sum(len(t["segments"]) for t in trips))

    def test_no_unnecessary_global_serialization(self):
        scheduler = Scheduler(Network())
        a = scheduler.reserve("B00", "B01", 0, 0)
        b = scheduler.reserve("B04", "B05", 0, 1)
        self.assertEqual(a["departure"], b["departure"])

    def test_repeated_fleet_scenarios_complete(self):
        for mode in ("random", "bottleneck", "opposing", "cycle"):
            with self.subTest(mode=mode):
                result = simulate(mode, fleet=30, rounds=20)
                self.assertTrue(result["metrics"]["passed"], result["metrics"])
                self.assertEqual(result["metrics"]["completed_trips"], 600)
                self.assertEqual(sorted(t["ready"] for t in result["trips"]),
                                 [t["ready"] for t in result["trips"]])

    def test_seed_sweep(self):
        for seed in range(50):
            with self.subTest(seed=seed):
                self.assertTrue(simulate(seed=seed, rounds=3)["metrics"]["passed"])

    def test_deterministic_trajectories(self):
        self.assertEqual(simulate(seed=11)["trips"], simulate(seed=11)["trips"])

    def test_invalid_inputs(self):
        for kwargs in (dict(fleet=0), dict(rounds=0), dict(clearance=-1)):
            with self.assertRaises(ValueError):
                simulate(**kwargs)


if __name__ == "__main__":
    unittest.main()
