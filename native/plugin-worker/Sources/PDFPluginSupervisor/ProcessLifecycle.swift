import Foundation
import Darwin

func terminateAndReap(_ process: Process) {
    guard process.isRunning else {
        process.waitUntilExit()
        return
    }
    process.terminate()
    for _ in 0..<25 {
        if !process.isRunning { break }
        usleep(10_000)
    }
    if process.isRunning { _ = kill(process.processIdentifier, SIGKILL) }
    process.waitUntilExit()
}
