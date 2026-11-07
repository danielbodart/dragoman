// Command zipdir writes a directory to a zip, flat (the directory's contents
// at the archive root), the same bytes every time: entries sorted, times
// fixed, and each file's mode kept, so the launcher and binaries stay
// executable when Claude Code unpacks the plugin.
//
//	go run ./internal/tools/zipdir DIR OUT.zip
package main

import (
	"archive/zip"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: zipdir DIR OUT.zip")
		os.Exit(2)
	}
	if err := write(os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, "zipdir:", err)
		os.Exit(1)
	}
}

func write(dir, out string) error {
	var paths []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			paths = append(paths, path)
		}
		return nil
	})
	if err != nil {
		return err
	}
	sort.Strings(paths)
	f, err := os.Create(out)
	if err != nil {
		return err
	}
	defer f.Close()
	w := zip.NewWriter(f)
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		header := &zip.FileHeader{Name: filepath.ToSlash(rel), Method: zip.Deflate, Modified: epoch}
		header.SetMode(info.Mode().Perm())
		entry, err := w.CreateHeader(header)
		if err != nil {
			return err
		}
		src, err := os.Open(path)
		if err != nil {
			return err
		}
		_, err = io.Copy(entry, src)
		src.Close()
		if err != nil {
			return err
		}
	}
	return w.Close()
}
