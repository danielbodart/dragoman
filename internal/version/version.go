// Package version is what this build calls itself.
package version

// Version is set at link time by ./run (-X). Without it, it says
// "development", which is the truth about a `go run`: it never guesses a
// number that would then appear in a bug report as if it had been released.
var Version = "development"
