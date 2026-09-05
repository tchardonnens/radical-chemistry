#!/bin/sh
# The two open dictionaries the whole project is derived from.
set -e
mkdir -p data
curl -sL -o data/dictionary.txt \
  https://raw.githubusercontent.com/skishore/makemeahanzi/master/dictionary.txt
curl -sL -o data/cedict.txt.gz \
  https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz
gunzip -f data/cedict.txt.gz
wc -l data/dictionary.txt data/cedict.txt
