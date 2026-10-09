"""Validate the version-1 replay contract without third-party packages.

Version 1 accepts legacy five-value tracks and optional acceleration/displacement
at positions 5/6. Extra object properties are retained for additive extensions.
"""
from __future__ import annotations

import math

ROLES = {"route", "coverage", "rush", "block", "pass", "ball", "other"}


def _fail(path, message):
    raise ValueError(f"{path}: {message}")


def _number(value, path):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(path, "expected a finite number")
    return value


def _finite_tree(value, path="dataset"):
    if isinstance(value, float) and not math.isfinite(value):
        _fail(path, "non-finite value")
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                _fail(path, "object keys must be strings")
            _finite_tree(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _finite_tree(child, f"{path}[{index}]")
    elif value is not None and not isinstance(value, (str, bool, int, float)):
        _fail(path, "unsupported JSON value")


def _tracks(track, size, path):
    if not isinstance(track, list) or len(track) != size:
        _fail(path, f"expected {size} aligned frames")
    width = None
    for i, row in enumerate(track):
        if not isinstance(row, list) or len(row) not in (5, 6, 7):
            _fail(f"{path}[{i}]", "expected [x,y,s,dir,o] with optional a,dis")
        if width is None:
            width = len(row)
        if len(row) != width:
            _fail(path, "track rows have inconsistent widths")
        for k, value in enumerate(row):
            if k >= 5 and value is None:
                continue
            _number(value, f"{path}[{i}][{k}]")
        if row[2] < 0:
            _fail(path, "speed must be nonnegative")
        if not 0 <= row[3] < 360 or not 0 <= row[4] < 360:
            _fail(path, "angles must be in [0,360)")
        if len(row) > 6 and row[6] is not None and row[6] < 0:
            _fail(path, "displacement must be nonnegative")


def _optional_fields(value, path, strings=(), numbers=(), booleans=(), nullable_strings=()):
    """Validate known additive context fields while preserving unknown fields."""
    if not isinstance(value, dict):
        _fail(path, "expected object")
    for key in strings:
        if key in value and not isinstance(value[key], str):
            _fail(path + "." + key, "expected string")
    for key in nullable_strings:
        if key in value and value[key] is not None and not isinstance(value[key], str):
            _fail(path + "." + key, "expected string or null")
    for key in numbers:
        if key in value and value[key] is not None:
            _number(value[key], path + "." + key)
    for key in booleans:
        if key in value and value[key] is not None and type(value[key]) is not bool:
            _fail(path + "." + key, "expected boolean or null")


def _validate_dataset(data):
    """Return data unchanged, or raise a descriptive ValueError on corruption."""
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        _fail("dataset.schemaVersion", "requires version 1")
    _finite_tree(data)
    meta, plays = data.get("meta"), data.get("plays")
    if not isinstance(meta, dict):
        _fail("dataset.meta", "missing object")
    if not isinstance(plays, list) or not plays:
        _fail("dataset.plays", "expected nonempty list")
    fps = _number(meta.get("fps"), "meta.fps")
    if fps <= 0:
        _fail("meta.fps", "must be positive")
    for name in ("fieldLength", "fieldWidth"):
        if _number(meta.get(name), "meta." + name) <= 0:
            _fail("meta." + name, "must be positive")
    if meta.get("playCount") != len(plays):
        _fail("meta.playCount", "does not match plays")
    precise = meta.get("separationPrecision") == "full"
    if "windowThreshold" in meta and _number(meta["windowThreshold"], "meta.windowThreshold") < 0:
        _fail("meta.windowThreshold", "must be nonnegative")
    tolerance = 1e-8 if precise else 0.000501
    play_ids = set()
    receiver_ids = {}
    for pi, play in enumerate(plays):
        path = f"plays[{pi}]"
        if not isinstance(play, dict):
            _fail(path, "expected object")
        ident = play.get("id")
        if not isinstance(ident, str) or ident in play_ids:
            _fail(path + ".id", "must be a unique string")
        play_ids.add(ident)
        if ident != f"{play.get('gameId')}_{play.get('playId')}":
            _fail(path + ".id", "does not match gameId/playId")
        for key in ("gameId", "playId", "quarter", "down", "yardsToGo"):
            if type(play.get(key)) is not int:
                _fail(path + "." + key, "expected integer")
        for key in ("los", "firstDown", "yards"):
            _number(play.get(key), path + "." + key)
        for key in ("homeTeam", "awayTeam", "offense", "defense", "description", "clock", "result", "endpointLabel"):
            if not isinstance(play.get(key), str):
                _fail(path + "." + key, "expected string")
        if play["down"] not in (1, 2, 3, 4) or play["quarter"] < 1 or play["yardsToGo"] < 0:
            _fail(path, "invalid football situation")
        if set((play["homeTeam"], play["awayTeam"])) != set((play["offense"], play["defense"])):
            _fail(path, "game teams do not match play teams")
        if not 0 <= play["los"] <= meta["fieldLength"] or not 0 <= play["firstDown"] <= meta["fieldLength"]:
            _fail(path, "line markers outside field length")
        if abs(play["firstDown"] - min(meta["fieldLength"], max(0, play["los"] + play["yardsToGo"]))) > 1e-6:
            _fail(path + ".firstDown", "does not match line of scrimmage and yards to go")
        for key in ("formation", "coverage", "coverageType"):
            if key in play and not isinstance(play[key], str):
                _fail(path + "." + key, "expected string")
        if "context" in play:
            _optional_fields(play["context"], path + ".context",
                             strings=("gameDate", "personnelO", "personnelD", "dropbackType"),
                             numbers=("season", "week", "defendersInBox", "homeScore", "awayScore"),
                             booleans=("playAction",))
        if play.get("offense") == play.get("defense"):
            _fail(path, "offense and defense must differ")
        times, frames, events = play.get("times"), play.get("frameIds"), play.get("events")
        if not isinstance(times, list) or len(times) < 2:
            _fail(path + ".times", "requires at least two observations")
        size = len(times)
        if not isinstance(frames, list) or not isinstance(events, list) or len(frames) != size or len(events) != size:
            _fail(path, "time, frame and event arrays must align")
        if any(type(frame) is not int for frame in frames):
            _fail(path + ".frameIds", "expected integer frames")
        for i, t in enumerate(times):
            _number(t, f"{path}.times[{i}]")
            if abs(t - i / fps) > 1e-6:
                _fail(path + ".times", "must start at zero and follow fps")
            if frames[i] != frames[0] + i:
                _fail(path + ".frameIds", "must be consecutive")
        if any(not isinstance(event, str) for event in events):
            _fail(path + ".events", "expected strings")
        if events[0] != "ball_snap":
            _fail(path + ".events", "must begin at ball_snap")
        if "pass_forward" in events[:-1]:
            _fail(path + ".events", "extends beyond first pass release")
        if play.get("endpointLabel") == "Pass release" and events[-1] != "pass_forward":
            _fail(path, "release endpoint missing pass_forward")
        if play.get("endpointLabel") != "Pass release" and play.get("result") not in {"S", "R"}:
            _fail(path, "non-release endpoint requires sack or scramble")
        players = play.get("players")
        if not isinstance(players, list) or len(players) != 23:
            _fail(path + ".players", "requires 22 players and ball")
        by_id, sides = {}, {"offense": 0, "defense": 0, "ball": 0}
        for ei, entity in enumerate(players):
            ep = f"{path}.players[{ei}]"
            if not isinstance(entity, dict):
                _fail(ep, "expected object")
            eid = entity.get("id")
            if not isinstance(eid, str) or not eid or eid in by_id:
                _fail(ep + ".id", "must be a unique nonempty string")
            by_id[eid] = entity
            side, role = entity.get("side"), entity.get("role")
            if side not in sides or role not in ROLES:
                _fail(ep, "invalid side or role")
            sides[side] += 1
            if side == "ball":
                if eid != "ball" or role != "ball" or entity.get("team") != "football":
                    _fail(ep, "invalid ball identity")
            elif eid == "ball" or role == "ball":
                _fail(ep, "ball identity and role require ball side")
            elif entity.get("team") != play[side]:
                _fail(ep + ".team", "does not match offense/defense")
            if role in {"coverage", "rush"} and side != "defense":
                _fail(ep + ".role", "defensive role on non-defender")
            if role in {"route", "pass", "block"} and side != "offense":
                _fail(ep + ".role", "offensive role on non-offense")
            for key in ("name", "jersey", "position", "officialPosition"):
                if key in entity and not isinstance(entity[key], str):
                    _fail(ep + "." + key, "expected string")
            if "scoutingAvailable" in entity and type(entity["scoutingAvailable"]) is not bool:
                _fail(ep + ".scoutingAvailable", "expected boolean")
            if "protection" in entity:
                _optional_fields(entity["protection"], ep + ".protection",
                                 nullable_strings=("blockedPlayerId", "blockType"),
                                 booleans=("hit", "hurry", "sack", "beatenByDefender", "hitAllowed", "hurryAllowed", "sackAllowed", "backFieldBlock"))
            _tracks(entity.get("track"), size, ep + ".track")
            if "fieldStatus" in entity:
                status = entity["fieldStatus"]
                if not isinstance(status, list) or len(status) != size or any(s not in {"in_bounds", "outside_field"} for s in status):
                    _fail(ep + ".fieldStatus", "invalid aligned field status")
                expected_status = ["in_bounds" if 0 <= row[0] <= meta["fieldLength"] and 0 <= row[1] <= meta["fieldWidth"] else "outside_field" for row in entity["track"]]
                if status != expected_status:
                    _fail(ep + ".fieldStatus", "does not match recorded positions")
        if sides != {"offense": 11, "defense": 11, "ball": 1}:
            _fail(path + ".players", "requires 11 players per team")
        defenders = [e for e in players if e["role"] == "coverage"]
        if not defenders:
            _fail(path, "no coverage defenders")
        routes = {e["id"] for e in players if e["role"] == "route"}
        metrics = play.get("metrics", {}).get("receivers")
        if not isinstance(metrics, list):
            _fail(path + ".metrics.receivers", "expected list")
        seen = set()
        for mi, metric in enumerate(metrics):
            mp = f"{path}.metrics.receivers[{mi}]"
            if not isinstance(metric, dict):
                _fail(mp, "expected object")
            rid = metric.get("id")
            if rid not in routes or rid in seen:
                _fail(mp + ".id", "must uniquely identify a route runner")
            seen.add(rid)
            sep, nearest = metric.get("separation"), metric.get("nearestId")
            if not isinstance(sep, list) or not isinstance(nearest, list) or len(sep) != size or len(nearest) != size:
                _fail(mp, "distance and nearest-defender arrays must align")
            actual = []
            for i, value in enumerate(sep):
                _number(value, f"{mp}.separation[{i}]")
                point = by_id[rid]["track"][i]
                expected, eid = min((math.hypot(point[0]-e["track"][i][0], point[1]-e["track"][i][1]), e["id"]) for e in defenders)
                actual.append(expected)
                if abs(value - expected) > tolerance or nearest[i] != eid:
                    _fail(mp, f"geometry or nearest defender inconsistent at frame {i}")
            for key, expected in (("peakSeparation", max(actual)), ("separationAtEnd", actual[-1])):
                if key in metric and abs(_number(metric[key], mp + "." + key)-expected) > tolerance:
                    _fail(mp + "." + key, "inconsistent with distances")
            threshold = meta.get("windowThreshold", 3.0)
            flags = [d >= threshold for d in actual[:-1]]
            total, longest, run = sum(flags)/fps, 0, 0
            for flag in flags:
                run = run + 1 if flag else 0
                longest = max(longest, run/fps)
            for key, expected in (("totalOpenSeconds", total), ("longestOpenSeconds", longest)):
                if key in metric and abs(_number(metric[key], mp + "." + key)-expected) > 1e-6:
                    _fail(mp + "." + key, "inconsistent interval duration")
        if seen != routes:
            _fail(path + ".metrics", "requires exactly one series per route runner")
        receiver_ids[ident] = routes
        bounds = play.get("bounds")
        if not isinstance(bounds, dict):
            _fail(path + ".bounds", "missing object")
        for axis, k in (("x", 0), ("y", 1)):
            points = [row[k] for entity in players for row in entity["track"]]
            for suffix, expected in (("Min", min(points)), ("Max", max(points))):
                key = axis + suffix
                if abs(_number(bounds.get(key), path + ".bounds." + key)-expected) > 1e-6:
                    _fail(path + ".bounds." + key, "does not enclose the recorded positions exactly")
        penalty = play.get("penalty")
        if penalty is not None:
            if not isinstance(penalty, dict) or any(type(penalty.get(key)) is not bool for key in ("hasPenalty", "nullified")):
                _fail(path + ".penalty", "requires boolean hasPenalty and nullified")
            if not isinstance(penalty.get("fouls"), list):
                _fail(path + ".penalty.fouls", "expected list")
            _optional_fields(penalty, path + ".penalty", strings=("nullifiedSource",), numbers=("yards", "prePenaltyYards"))
            for foul in penalty["fouls"]:
                _optional_fields(foul, path + ".penalty.fouls", strings=("name",), nullable_strings=("playerId",))
                if not isinstance(foul.get("name"), str) or not foul["name"]:
                    _fail(path + ".penalty.fouls", "requires nonempty foul name")
            if penalty["nullified"] and play.get("cohortEligible") is True:
                _fail(path + ".cohortEligible", "nullified play cannot be analysis eligible")
        if "cohortEligible" in play and type(play["cohortEligible"]) is not bool:
            _fail(path + ".cohortEligible", "expected boolean")
        quality = play.get("quality")
        if quality is not None:
            if not isinstance(quality, dict) or not isinstance(quality.get("flags"), list):
                _fail(path + ".quality", "requires diagnostic flags")
            if any(not isinstance(flag, str) for flag in quality["flags"]) or len(set(quality["flags"])) != len(quality["flags"]):
                _fail(path + ".quality.flags", "expected unique strings")
            counts = {role: sum(e["role"] == role for e in players) for role in {e["role"] for e in players}}
            if quality.get("roleCounts") != counts:
                _fail(path + ".quality.roleCounts", "does not match player roles")
            for key in ("scoutingMissingIds", "unknownRoleIds"):
                if not isinstance(quality.get(key), list) or any(eid not in by_id for eid in quality[key]):
                    _fail(path + ".quality." + key, "references unknown entities")
                if len(set(quality[key])) != len(quality[key]):
                    _fail(path + ".quality." + key, "duplicate entity")
            if all("scoutingAvailable" in e for e in players) and set(quality["scoutingMissingIds"]) != {e["id"] for e in players if not e["scoutingAvailable"]}:
                _fail(path + ".quality.scoutingMissingIds", "does not match player availability")
            if set(quality["unknownRoleIds"]) != {e["id"] for e in players if e["role"] == "other"}:
                _fail(path + ".quality.unknownRoleIds", "does not match player roles")
            ambiguity = quality.get("fieldAmbiguity", {})
            outside = {e["id"] for e in players if e["side"] != "ball" and any(not (0 <= row[0] <= meta["fieldLength"] and 0 <= row[1] <= meta["fieldWidth"]) for row in e["track"])}
            if set(ambiguity.get("entityIds", [])) != outside:
                _fail(path + ".quality.fieldAmbiguity", "does not match player positions")
            expected_presence = {"scouting_missing": bool(quality["scoutingMissingIds"]), "unknown_roles": bool(quality["unknownRoleIds"]), "field_boundary": bool(outside)}
            for flag, present in expected_presence.items():
                if (flag in quality["flags"]) != present:
                    _fail(path + ".quality.flags", "does not match " + flag + " observations")
            if play.get("cohortEligible") and any(flag in quality["flags"] for flag in ("scouting_missing", "unknown_roles", "field_boundary", "trajectory_flag", "event_disagreement")):
                _fail(path + ".cohortEligible", "does not match diagnostic flags")
        pre = play.get("preSnap")
        if pre is not None:
            if not isinstance(pre, dict):
                _fail(path + ".preSnap", "expected object")
            pt, pf, pe, pp = (pre.get(k) for k in ("times", "frameIds", "events", "players"))
            if not all(isinstance(v, list) for v in (pt, pf, pe, pp)) or len(pt) != len(pf) or len(pt) != len(pe):
                _fail(path + ".preSnap", "invalid aligned arrays")
            if any(not isinstance(event, str) for event in pe):
                _fail(path + ".preSnap.events", "expected strings")
            if pf and pf[-1] != frames[0]-1:
                _fail(path + ".preSnap.frameIds", "must end immediately before snap")
            if len({e.get("id") for e in pp}) != len(pp) or set(e.get("id") for e in pp) != set(by_id):
                _fail(path + ".preSnap.players", "must identify the replay entities")
            for i, t in enumerate(pt):
                _number(t, path + ".preSnap.times")
                if type(pf[i]) is not int or pf[i] >= frames[0] or abs(t-(pf[i]-frames[0])/fps) > 1e-6 or t >= 0:
                    _fail(path + ".preSnap", "invalid negative timing")
                if i and pf[i] != pf[i-1]+1:
                    _fail(path + ".preSnap", "frames must be consecutive")
            for entity in pp:
                _tracks(entity.get("track"), len(pt), path + ".preSnap.track")
    if meta.get("gameCount") != len({p["gameId"] for p in plays}):
        _fail("meta.gameCount", "does not match plays")
    if any(pid not in play_ids for pid in data.get("featured", [])):
        _fail("dataset.featured", "references unknown play")
    for i, story in enumerate(data.get("stories", [])):
        for key, receiver_key in (("id", "receiverId"), ("compareId", "compareReceiverId")):
            if story.get(key) not in play_ids or story.get(receiver_key) not in receiver_ids[story[key]]:
                _fail(f"stories[{i}]", "references unknown play or receiver")
        focus = _number(story.get("focusTime"), f"stories[{i}].focusTime")
        selected = next(p for p in plays if p["id"] == story["id"])
        if not 0 <= focus <= selected["times"][-1]:
            _fail(f"stories[{i}].focusTime", "outside recorded replay")
    return data


def validate_dataset(data):
    """Return a compatible dataset unchanged or raise descriptive ValueError."""
    try:
        return _validate_dataset(data)
    except (KeyError, IndexError, TypeError, AttributeError) as error:
        raise ValueError(f"dataset: malformed nested schema value ({error})") from error
