import CryptoKit
import Darwin
import Foundation

func privateTrustDirectory(_ url: URL) -> Bool {
    var information = stat()
    guard lstat(url.path, &information) == 0,
          (information.st_mode & S_IFMT) == S_IFDIR,
          (information.st_mode & 0o077) == 0,
          information.st_nlink >= 1
    else { return false }
    return true
}

func validatedTrustWorkspace(requestPath: String) throws -> (workspace: URL, request: URL) {
    guard requestPath.hasPrefix("/") else { throw TrustFailure.unsafeWorkspace }
    let request = URL(fileURLWithPath: requestPath).standardizedFileURL
    let workspace = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).standardizedFileURL
    guard request.lastPathComponent == "request.json",
          request.deletingLastPathComponent() == workspace,
          privateTrustDirectory(workspace)
    else {
        throw TrustFailure.unsafeWorkspace
    }
    return (workspace, request)
}

func readPrivateTrustFile(_ url: URL, maximumBytes: Int, emptyAllowed: Bool, oversize: TrustFailure) throws -> Data {
    var expected = stat()
    guard lstat(url.path, &expected) == 0,
          (expected.st_mode & S_IFMT) == S_IFREG,
          (expected.st_mode & 0o077) == 0,
          expected.st_nlink == 1,
          expected.st_size >= (emptyAllowed ? 0 : 1)
    else { throw TrustFailure.unsafeWorkspace }
    guard expected.st_size <= off_t(maximumBytes) else { throw oversize }

    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw TrustFailure.unsafeWorkspace }
    defer { close(descriptor) }

    return try readPrivateDescriptor(
        descriptor, expected: expected, maximumBytes: maximumBytes, emptyAllowed: emptyAllowed, oversize: oversize
    )
}

func readPrivateCMSDump(workspace: URL, index: Int, maximumBytes: Int) throws -> Data {
    let dumps = workspace.appendingPathComponent("dumps", isDirectory: true)
    let directoryDescriptor = open(dumps.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard directoryDescriptor >= 0 else { throw TrustFailure.unsafeWorkspace }
    defer { close(directoryDescriptor) }

    var directory = stat()
    guard fstat(directoryDescriptor, &directory) == 0,
          (directory.st_mode & S_IFMT) == S_IFDIR,
          (directory.st_mode & 0o077) == 0
    else { throw TrustFailure.unsafeWorkspace }

    let filename = "input.pdf.sig\(index)"
    var expected = stat()
    guard fstatat(directoryDescriptor, filename, &expected, AT_SYMLINK_NOFOLLOW) == 0,
          (expected.st_mode & S_IFMT) == S_IFREG,
          (expected.st_mode & 0o077) == 0,
          expected.st_nlink == 1,
          expected.st_size > 0
    else { throw TrustFailure.unsafeWorkspace }
    guard expected.st_size <= off_t(maximumBytes) else { throw TrustFailure.resourceLimit }

    let descriptor = openat(directoryDescriptor, filename, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw TrustFailure.unsafeWorkspace }
    defer { close(descriptor) }
    return try readPrivateDescriptor(
        descriptor, expected: expected, maximumBytes: maximumBytes, emptyAllowed: false, oversize: .resourceLimit
    )
}

private func readPrivateDescriptor(
    _ descriptor: Int32,
    expected: stat,
    maximumBytes: Int,
    emptyAllowed: Bool,
    oversize: TrustFailure
) throws -> Data {

    var opened = stat()
    guard fstat(descriptor, &opened) == 0,
          (opened.st_mode & S_IFMT) == S_IFREG,
          (opened.st_mode & 0o077) == 0,
          opened.st_nlink == 1,
          opened.st_size == expected.st_size,
          opened.st_dev == expected.st_dev,
          opened.st_ino == expected.st_ino,
          opened.st_size <= off_t(maximumBytes),
          opened.st_size >= (emptyAllowed ? 0 : 1)
    else { throw TrustFailure.unsafeWorkspace }

    var data = Data()
    data.reserveCapacity(Int(opened.st_size))
    var buffer = [UInt8](repeating: 0, count: 1_048_576)
    while true {
        let count = read(descriptor, &buffer, buffer.count)
        guard count >= 0 else { throw TrustFailure.unsafeWorkspace }
        if count == 0 { break }
        guard data.count <= maximumBytes - count else { throw oversize }
        data.append(buffer, count: count)
    }
    var final = stat()
    guard fstat(descriptor, &final) == 0,
          final.st_dev == opened.st_dev,
          final.st_ino == opened.st_ino,
          final.st_size == opened.st_size,
          final.st_mtimespec.tv_sec == opened.st_mtimespec.tv_sec,
          final.st_mtimespec.tv_nsec == opened.st_mtimespec.tv_nsec,
          final.st_ctimespec.tv_sec == opened.st_ctimespec.tv_sec,
          final.st_ctimespec.tv_nsec == opened.st_ctimespec.tv_nsec,
          data.count == Int(opened.st_size)
    else { throw TrustFailure.unsafeWorkspace }
    return data
}

func trustSHA256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
