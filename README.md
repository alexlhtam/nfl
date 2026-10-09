# Open Field

Open Field is an interactive coaching tool that shows where defensive coverage leaves space and when receivers arrive there.
Coaches can replay every included play, compare two plays from the snap, inspect a receiver's separation timeline, and export a field image for discussion.
The reproducible Python pipeline uses the event repository's actual 2021 tracking and scouting files, and the included dataset covers two games with source provenance recorded alongside it.
The maps show measured distance to coverage defenders and its change over time, while route windows use a visible, adjustable distance threshold rather than a claim about catch probability or player responsibility.
Run `python app.py` with Python 3.10 or newer, or create a portable offline demo with `python app.py --export submission/open-field.html`; see [the guide](GUIDE.md) for data rebuilding, definitions, limitations, and validation.

![Open Field coaching tool](docs/open-field.png)
