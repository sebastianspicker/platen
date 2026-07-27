import Darwin
import Foundation

private func privateDirectory(_ url: URL) -> Bool {
    var info = stat()
    guard lstat(url.path, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFDIR,
          (info.st_mode & 0o777) == 0o700
    else { return false }
    guard let real = realpath(url.path, nil) else { return false }
    defer { free(real) }
    return true
}

func validatedSigningWorkspace(requestPath: String) throws -> (URL, URL) {
    guard requestPath.hasPrefix("/") else { throw SigningFailure.unsafeWorkspace }
    let workspacePath = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).standardizedFileURL
    guard privateDirectory(workspacePath), let workspaceReal = realpath(workspacePath.path, nil) else {
        throw SigningFailure.unsafeWorkspace
    }
    let workspace = URL(fileURLWithPath: String(cString: workspaceReal)).standardizedFileURL
    free(workspaceReal)
    let request = URL(fileURLWithPath: requestPath).standardizedFileURL
    guard request.lastPathComponent == "request.json",
          privatePrivateFile(request, maximumBytes: maxSigningRequestBytes, emptyAllowed: false)
    else { throw SigningFailure.unsafeWorkspace }
    guard let canonicalWorkspaceReal = realpath(workspace.path, nil),
          let requestParentReal = realpath(request.deletingLastPathComponent().path, nil)
    else { throw SigningFailure.unsafeWorkspace }
    defer { free(canonicalWorkspaceReal); free(requestParentReal) }
    guard String(cString: canonicalWorkspaceReal) == String(cString: requestParentReal) else {
        throw SigningFailure.unsafeWorkspace
    }
    guard let real = realpath(request.path, nil) else { throw SigningFailure.unsafeWorkspace }
    defer { free(real) }
    guard String(cString: real) == String(cString: canonicalWorkspaceReal) + "/request.json" else {
        throw SigningFailure.unsafeWorkspace
    }
    return (workspace, request)
}

private func privatePrivateFile(_ url: URL, maximumBytes: Int, emptyAllowed: Bool) -> Bool {
    var info = stat()
    guard lstat(url.path, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFREG,
          (info.st_mode & 0o777) == 0o600,
          info.st_nlink == 1,
          info.st_size >= (emptyAllowed ? 0 : 1),
          info.st_size <= off_t(maximumBytes)
    else { return false }
    return true
}

func readPrivateSigningFile(_ url: URL, maximumBytes: Int, emptyAllowed: Bool = false) throws -> Data {
    var expected = stat()
    guard lstat(url.path, &expected) == 0,
          (expected.st_mode & S_IFMT) == S_IFREG,
          (expected.st_mode & 0o777) == 0o600,
          expected.st_nlink == 1,
          expected.st_size >= (emptyAllowed ? 0 : 1)
    else { throw SigningFailure.unsafeWorkspace }
    guard expected.st_size <= off_t(maximumBytes) else { throw SigningFailure.inputTooLarge }
    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw SigningFailure.unsafeWorkspace }
    defer { close(descriptor) }
    var opened = stat()
    guard fstat(descriptor, &opened) == 0,
          opened.st_dev == expected.st_dev, opened.st_ino == expected.st_ino,
          opened.st_size == expected.st_size, opened.st_nlink == 1
    else { throw SigningFailure.unsafeWorkspace }
    var output = Data(); output.reserveCapacity(Int(opened.st_size))
    var buffer = [UInt8](repeating: 0, count: 1_048_576)
    while true {
        let count = read(descriptor, &buffer, buffer.count)
        guard count >= 0 else { throw SigningFailure.unsafeWorkspace }
        if count == 0 { break }
        guard output.count <= maximumBytes - count else { throw SigningFailure.inputTooLarge }
        output.append(buffer, count: count)
    }
    var final = stat()
    guard fstat(descriptor, &final) == 0,
          final.st_dev == opened.st_dev, final.st_ino == opened.st_ino,
          final.st_size == opened.st_size, output.count == Int(opened.st_size)
    else { throw SigningFailure.unsafeWorkspace }
    return output
}

func writePrivateCMS(_ data: Data, workspace: URL) throws {
    guard data.count > 0, data.count <= maxSigningCMSBytes else { throw SigningFailure.cmsFailed }
    let url = workspace.appendingPathComponent(signingOutputFilename)
    var existing = stat()
    if lstat(url.path, &existing) == 0 { throw SigningFailure.outputExists }
    let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
    guard descriptor >= 0 else { throw SigningFailure.outputWriteFailed }
    defer { close(descriptor) }
    var offset = 0
    try data.withUnsafeBytes { rawBuffer in
        guard let base = rawBuffer.baseAddress else { throw SigningFailure.outputWriteFailed }
        while offset < data.count {
            let written = Darwin.write(descriptor, base.advanced(by: offset), data.count - offset)
            guard written > 0 else { throw SigningFailure.outputWriteFailed }
            offset += written
        }
    }
    guard fchmod(descriptor, mode_t(0o600)) == 0 else { throw SigningFailure.outputWriteFailed }
    var info = stat()
    guard fstat(descriptor, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFREG,
          (info.st_mode & 0o777) == 0o600,
          info.st_nlink == 1,
          info.st_size == off_t(data.count)
    else { throw SigningFailure.outputWriteFailed }
}
