//! The flight network's tracks: what each flight between two flight masters flies, from Polestar's
//! own Maps/FlightPaths.lua (generated from the game's TaxiPathNode table; world yards, wx north,
//! wy west), compiled in. A `taxi` record names only where the flight began and where it was going,
//! so a flight with stops is the shortest chain of tracks between the two.

use std::collections::{BinaryHeap, HashMap};
use std::sync::OnceLock;

const SOURCE: &str = include_str!("../../../addon/Polestar/Maps/FlightPaths.lua");

/// tracks[from][to] = flat wx, wy pairs.
type Tracks = HashMap<i64, HashMap<i64, Vec<f64>>>;

fn tracks() -> &'static Tracks {
	static T: OnceLock<Tracks> = OnceLock::new();
	T.get_or_init(|| parse(SOURCE))
}

/// `[from] = {` opens a node; `[to] = {x,y,...},` inside it is one track.
fn parse(src: &str) -> Tracks {
	let mut out: Tracks = HashMap::new();
	let mut from: Option<i64> = None;
	let id = |s: &str| s.trim().strip_prefix('[').and_then(|s| s.split(']').next()).and_then(|n| n.parse::<i64>().ok());
	for line in src.lines() {
		let l = line.trim_end();
		if l.starts_with("\t[") && !l.starts_with("\t\t") && l.ends_with('{') {
			from = id(l);
		} else if l.starts_with("\t\t[") {
			let (Some(f), Some(to)) = (from, id(l)) else { continue };
			let Some(body) = l.split_once('{').map(|(_, b)| b.trim_end_matches(',').trim_end_matches('}')) else { continue };
			let pts: Vec<f64> = body.split(',').filter_map(|v| v.trim().parse().ok()).collect();
			if pts.len() >= 4 && pts.len() % 2 == 0 {
				out.entry(f).or_default().insert(to, pts);
			}
		}
	}
	out
}

fn length(p: &[f64]) -> f64 {
	p.chunks(2).collect::<Vec<_>>().windows(2).map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt()).sum()
}

/// The way a flight from node `from` to node `to` goes: its tracks joined (flat wx, wy pairs), or
/// None when the network has no way between them.
pub fn route(from: i64, to: i64) -> Option<Vec<f64>> {
	route_in(tracks(), from, to)
}

fn route_in(t: &Tracks, from: i64, to: i64) -> Option<Vec<f64>> {
	if from == to {
		return None;
	}
	// Dijkstra on track lengths (yards, rounded: the heap needs a total order).
	let mut dist: HashMap<i64, i64> = HashMap::from([(from, 0)]);
	let mut prev: HashMap<i64, i64> = HashMap::new();
	let mut heap = BinaryHeap::from([(0i64, from)]);
	while let Some((d, n)) = heap.pop() {
		let d = -d;
		if n == to {
			break;
		}
		if dist.get(&n).is_some_and(|&best| d > best) {
			continue;
		}
		for (&m, p) in t.get(&n).into_iter().flatten() {
			let nd = d + length(p).round() as i64;
			if dist.get(&m).is_none_or(|&best| nd < best) {
				dist.insert(m, nd);
				prev.insert(m, n);
				heap.push((-nd, m));
			}
		}
	}
	if !prev.contains_key(&to) {
		return None;
	}
	let mut hops = vec![to];
	while let Some(&p) = prev.get(hops.last().unwrap()) {
		hops.push(p);
	}
	hops.reverse();
	let mut out: Vec<f64> = Vec::new();
	for w in hops.windows(2) {
		let p = &t[&w[0]][&w[1]];
		// Each track starts at the node the last one ended at: drop the repeated point.
		out.extend_from_slice(if out.is_empty() { p } else { &p[2..] });
	}
	Some(out)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reads_polestars_tracks_and_chains_them() {
		let t = tracks();
		assert!(t.len() > 40, "{} nodes", t.len());
		// Stormwind (2) to Sentinel Hill (4) is one track.
		let direct = route(2, 4).unwrap();
		assert_eq!(direct, t[&2][&4]);
		// A made-up network: 1 -> 2 -> 3 is shorter than 1 -> 3 straight.
		let mut net: Tracks = HashMap::new();
		net.entry(1).or_default().insert(2, vec![0.0, 0.0, 10.0, 0.0]);
		net.entry(2).or_default().insert(3, vec![10.0, 0.0, 20.0, 0.0]);
		net.entry(1).or_default().insert(3, vec![0.0, 0.0, 0.0, 50.0, 20.0, 0.0]);
		assert_eq!(route_in(&net, 1, 3).unwrap(), vec![0.0, 0.0, 10.0, 0.0, 20.0, 0.0]);
		assert_eq!(route_in(&net, 3, 1), None);
	}
}
