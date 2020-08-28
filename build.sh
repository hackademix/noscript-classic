#!/bin/bash
# Version number to be replaced in the relevant source files
VER=5.1.9

# Source directory
SRC=src
# XPI directory
XPI=xpi

DESTFILE="$PWD/$XPI/noscript-$VER.xpi"

# Update version number where needed
VER_RX='[0-9][0-9.]*(?:-?[a-z]+[0-9]+)?';
perl -pi -e 's/(<em:(?:version|updateURL)>.*?)'"$VER_RX"'/${1}'"$VER"'/' \
   "$SRC/install.rdf"
perl -pi -e 's/(VERSION:\s*['"'"'"])'"$VER_RX"'/${1}'"$VER"'/' \
   "$SRC/chrome/content/noscript/Main.js"
perl -pi -e 's/("version",\s*\["|<label.*(?:Version\s+|changelog#))'"$VER_RX"'/${1}'"$VER"'/' \
    "$SRC/chrome/content/noscript/about.xul"
perl -pi -e 's/(<!ENTITY\s*noscriptAbout\s*".*?)'"$VER_RX"'/${1}'"$VER"'/' \
   "$SRC"/chrome/locale/*/noscript/noscript.dtd

# Let's package
mkdir -p "$XPI"
pushd >/dev/null 2>&1 "$SRC"
if zip -rq9 "$DESTFILE" **; then
  echo "Created $DESTFILE"
fi	
popd >/dev/null 2>&1
