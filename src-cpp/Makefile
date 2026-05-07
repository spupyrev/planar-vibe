# C++ port build.
# Usage: make            # build everything
#        make test       # build + run tests
#        make clean

CXX      ?= g++
CXXSTD   ?= -std=c++17
OPT      ?= -O2
WARN     ?= -Wall -Wextra -Wpedantic
DEBUG    ?= 0

ifeq ($(DEBUG),1)
  OPT := -O0 -g
endif

CXXFLAGS ?= $(CXXSTD) $(OPT) $(WARN) -Iinclude -MMD -MP
# Embed the compiler's libstdc++ rpath so the binaries run on machines whose
# system libstdc++ is older than what the compiler emits. Harmless when the
# system runtime is already up to date. Override by setting LDFLAGS= explicitly.
GCCLIBDIR := $(shell $(CXX) --print-file-name=libstdc++.so 2>/dev/null | xargs -I{} dirname {} 2>/dev/null)
ifneq ($(GCCLIBDIR),)
  LDFLAGS  ?= -Wl,-rpath,$(GCCLIBDIR)
else
  LDFLAGS  ?=
endif

BUILD    := build
APP      := $(BUILD)/apply_layout
TEST     := $(BUILD)/test_main

SRC       := $(wildcard src/*.cpp)
OBJ       := $(patsubst src/%.cpp,$(BUILD)/%.o,$(SRC))
DEPS      := $(OBJ:.o=.d) $(BUILD)/apply_layout.d $(BUILD)/test_main.d

.PHONY: all test clean release
all: $(APP) $(TEST)

# Self-contained release build. Statically links libstdc++ / libgcc so the
# binary runs on other Linux machines without the compiler's runtime present.
# Produces $(BUILD)/apply_layout-release. Uses -O3 + LTO for speed.
release: LDFLAGS := -static-libstdc++ -static-libgcc
release: OPT := -O3 -flto
release: $(BUILD)/apply_layout-release

$(BUILD)/apply_layout-release: $(OBJ) $(BUILD)/apply_layout.o
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $^ $(LDFLAGS) -o $@


$(APP): $(OBJ) $(BUILD)/apply_layout.o
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $^ $(LDFLAGS) -o $@

$(TEST): $(OBJ) $(BUILD)/test_main.o
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $^ $(LDFLAGS) -o $@

$(BUILD)/%.o: src/%.cpp
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD)/apply_layout.o: apps/apply_layout.cpp
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD)/test_main.o: tests/test_main.cpp
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -c $< -o $@

test: $(TEST)
	$(TEST)

clean:
	rm -rf $(BUILD)

-include $(DEPS)
