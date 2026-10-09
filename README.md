# Open Field

Open Field is a coaching tool built around **Coverage Lift**, an experimental signed-yard metric that separates the geometric contribution of defensive movement from receiver movement to a change in separation.
Coaches, scouts, and broadcasters can replay tracking, inspect the four-distance calculation, compare routes and plays, and investigate where defenders vacated space before a receiver arrived.
The verified demonstration shows Evan Engram gaining 1.09 yards of separation from a +2.64-yard defensive contribution and a −1.54-yard receiver contribution, contrasted with a Tyreek Hill opening driven mainly by receiver movement.
The offline package includes 321 plays across four 2021 games in two packs, annotated exports, reproducible Python and browser checks, and explicit limits: Coverage Lift measures geometry, not causal decoy credit, catch probability, or proven coaching usefulness.
Run `python app.py` with Python 3.10 or newer to open the tool in your browser, then follow the [four-minute demonstration](docs/DEMO.md) or [coaching guide](GUIDE.md#start-with-the-metric).

## Run locally · Python 3.10+

```sh
python app.py
```

**Portable offline HTML**

```sh
python app.py --export submission/Open-Field.html
```

## For judges

| Start here | Location |
| --- | --- |
| Four-minute demonstration | [Engram, Hill, and the coaching workflow](docs/DEMO.md) |
| Method | [Formula, worked examples, and limits](docs/METRIC.md) |
| Evidence | [Validation record](VALIDATION.md) |
| Verified 2021 data | [Default pack provenance](data/provenance.json) · [Additional pack provenance](data/packs/week-1-additional/provenance.json) |
| Code and reproduction | [Repository map](GUIDE.md#repository-map) · [Rebuild and verify](GUIDE.md#rebuild-and-verify) |

![Open Field coaching tool](docs/open-field.png)

## Side project

**Top banner → project overview and original deck download:** [Fruit fly in the pocket](web/side-projects/fruit-fly-in-the-pocket/fruit-fly-in-the-pocket.pptx)
