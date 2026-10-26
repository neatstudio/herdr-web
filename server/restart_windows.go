//go:build windows

package server

import "errors"

func execSelf(string) error {
	return errors.New("self-restart is not supported on windows")
}
