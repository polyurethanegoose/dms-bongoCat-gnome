UUID     := bongo-cat@polyurethanegoose
DEST     := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES  := metadata.json extension.js prefs.js stylesheet.css lib assets/skins assets/sounds schemas LICENSE
PYTHON   ?= python3

.PHONY: all schemas glyphs pot install uninstall zip clean check

all: schemas

schemas: schemas/gschemas.compiled
schemas/gschemas.compiled: schemas/*.gschema.xml
	glib-compile-schemas --strict schemas

# Regenerate lib/catGlyphs.js from the font (needs `pip install fonttools`).
glyphs:
	$(PYTHON) tools/generate_glyphs.py assets/bongocat-Regular.otf lib/catGlyphs.js

pot:
	mkdir -p po
	xgettext --from-code=UTF-8 -L JavaScript -k_ -o po/bongo-cat.pot extension.js prefs.js lib/*.js

install: schemas
	rm -rf $(DEST)
	mkdir -p $(DEST)/assets
	cp -r metadata.json extension.js prefs.js stylesheet.css lib schemas LICENSE $(DEST)/
	cp -r assets/skins assets/sounds $(DEST)/assets/
	@echo "Installed to $(DEST)."
	@echo "Wayland: log out and back in, then: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(DEST)

zip: schemas
	rm -f $(UUID).shell-extension.zip
	zip -qr $(UUID).shell-extension.zip $(SOURCES)

# Render all poses to preview.png and run the logic tests (no GNOME Shell needed).
check: schemas
	gjs -m tools/render-preview.js $(CURDIR) preview.png
	gjs -m tools/test-logic.js $(CURDIR)

clean:
	rm -f schemas/gschemas.compiled preview.png $(UUID).shell-extension.zip
