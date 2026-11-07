package main

// The plugin's bin/dragoman launcher, run by sh with a fake uname on PATH.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// plugin lays out bin/ as the zip does, each binary a script saying which it
// is, and a PATH whose uname answers as os and arch ("" for no uname).
func plugin(t *testing.T, osName, arch string) (string, []string) {
	t.Helper()
	root := t.TempDir()
	launcher, err := os.ReadFile("packaging/launcher")
	if err != nil {
		t.Fatal(err)
	}
	write := func(path, content string) {
		_ = os.MkdirAll(filepath.Dir(path), 0o755)
		if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(root, "bin", "dragoman"), string(launcher))
	for _, target := range []string{"linux-x86_64", "linux-aarch64", "darwin-arm64"} {
		write(filepath.Join(root, "bin", target, "dragoman"), "#!/bin/sh\necho \""+target+" $*\"\n")
	}
	tools := filepath.Join(root, "tools")
	_ = os.MkdirAll(tools, 0o755)
	for _, tool := range []string{"dirname", "sh"} {
		path, err := exec.LookPath(tool)
		if err != nil {
			t.Skipf("%s not found", tool)
		}
		_ = os.Symlink(path, filepath.Join(tools, tool))
	}
	if osName != "" {
		write(filepath.Join(tools, "uname"), "#!/bin/sh\ncase \"$1\" in -s) echo '"+osName+"' ;; -m) echo '"+arch+"' ;; esac\n")
	}
	return filepath.Join(root, "bin", "dragoman"), []string{"PATH=" + tools}
}

func launch(t *testing.T, osName, arch string, args ...string) (string, string, int) {
	t.Helper()
	launcher, env := plugin(t, osName, arch)
	sh, _ := exec.LookPath("sh")
	cmd := exec.Command(sh, append([]string{launcher}, args...)...)
	cmd.Env = env
	var out, errs strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errs
	code := 0
	if err := cmd.Run(); err != nil {
		code = cmd.ProcessState.ExitCode()
	}
	return out.String(), errs.String(), code
}

func TestTheLauncherPicksTheBinaryForThisMachine(t *testing.T) {
	for _, c := range []struct{ os, arch, want string }{
		{"Linux", "x86_64", "linux-x86_64"},
		{"Linux", "aarch64", "linux-aarch64"},
		{"Linux", "arm64", "linux-aarch64"},
		{"Darwin", "arm64", "darwin-arm64"},
	} {
		out, _, code := launch(t, c.os, c.arch, "serve")
		if code != 0 || strings.TrimSpace(out) != c.want+" serve" {
			t.Fatalf("%s %s: got %q, %d", c.os, c.arch, out, code)
		}
	}
}

// On Windows, a hook prints nothing and serve says why; both exit 0.
func TestTheLauncherDoesNothingOnWindows(t *testing.T) {
	for _, osName := range []string{"MINGW64_NT-10.0-22631", "MSYS_NT-10.0", "CYGWIN_NT-10.0", ""} {
		out, errs, code := launch(t, osName, "x86_64", "hook", "posture")
		if code != 0 || out != "" || errs != "" {
			t.Fatalf("%q hook: got %q, %q, %d", osName, out, errs, code)
		}
		out, errs, code = launch(t, osName, "x86_64", "serve")
		if code != 0 || out != "" || strings.TrimSpace(errs) != "Dragoman does not support Windows; use WSL" {
			t.Fatalf("%q serve: got %q, %q, %d", osName, out, errs, code)
		}
	}
}

// An architecture Dragoman doesn't build for gets the same treatment, naming
// the platforms it does, not a bare "exec format error".
func TestTheLauncherDoesNothingOnAnUnsupportedPlatform(t *testing.T) {
	for _, c := range [][2]string{{"Linux", "riscv64"}, {"Darwin", "x86_64"}, {"FreeBSD", "amd64"}} {
		out, errs, code := launch(t, c[0], c[1], "serve")
		if code != 0 || out != "" || !strings.Contains(errs, "Linux (x86_64, aarch64) and macOS on Apple silicon, not "+c[0]+" "+c[1]) {
			t.Fatalf("%v: got %q, %q, %d", c, out, errs, code)
		}
		if out, errs, _ := launch(t, c[0], c[1], "hook", "check"); out != "" || errs != "" {
			t.Fatalf("%v hook: got %q, %q", c, out, errs)
		}
	}
}
