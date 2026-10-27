# -*- coding: utf-8 -*-
# ComfyUI-EXR-Inspector - by David Borrull
# MIT License - Copyright (c) 2026 David Borrull. See LICENSE.
"""Thread-safe LRU cache with a byte budget. Concurrent requests for the same
key wait for the first one instead of decoding the layer twice."""

import threading
from collections import OrderedDict


class ByteLRU(object):
    def __init__(self, budget_bytes):
        self.budget = int(budget_bytes)
        self.used = 0
        self._items = OrderedDict()          # key -> (value, size)
        self._lock = threading.Lock()
        self._building = {}                  # key -> threading.Event

    def get_or_build(self, key, build, size_of):
        while True:
            with self._lock:
                if key in self._items:
                    self._items.move_to_end(key)
                    return self._items[key][0]
                event = self._building.get(key)
                if event is None:
                    event = self._building[key] = threading.Event()
                    break
            event.wait()                     # someone else is building it
        try:
            value = build()
        except BaseException:
            with self._lock:
                self._building.pop(key).set()
            raise
        size = int(size_of(value))
        with self._lock:
            self._building.pop(key).set()
            if size <= self.budget:
                self._items[key] = (value, size)
                self.used += size
                while self.used > self.budget:
                    _, (_, s) = self._items.popitem(last=False)
                    self.used -= s
        return value

    def clear(self):
        with self._lock:
            self._items.clear()
            self.used = 0
