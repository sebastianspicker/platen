import Foundation
import Darwin

func privateDirectory(_ url: URL) -> Bool {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
          let type = attributes[.type] as? FileAttributeType, type == .typeDirectory,
          let permissions = attributes[.posixPermissions] as? NSNumber
    else { return false }
    return (permissions.intValue & 0o077) == 0
}

func privateRegularFile(_ url: URL) -> Bool {
    if (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) != nil { return false }
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
          let type = attributes[.type] as? FileAttributeType, type == .typeRegular,
          let permissions = attributes[.posixPermissions] as? NSNumber
    else { return false }
    return (permissions.intValue & 0o077) == 0 && (attributes[.referenceCount] as? NSNumber)?.intValue == 1
}

func validatedWorkspace(requestPath: String) throws -> (workspace: URL, request: URL) {
    guard requestPath.hasPrefix("/") else { throw InspectionFailure.unsafeWorkspace }
    let request = URL(fileURLWithPath: requestPath).standardizedFileURL
    let workspace = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).standardizedFileURL
    guard request.deletingLastPathComponent() == workspace,
          privateDirectory(workspace), privateRegularFile(request)
    else { throw InspectionFailure.unsafeWorkspace }
    return (workspace, request)
}

func validatedProtectionWorkspace() throws -> URL {
    let workspace = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).standardizedFileURL
    guard privateDirectory(workspace),
          let entries = try? FileManager.default.contentsOfDirectory(atPath: workspace.path),
          entries.allSatisfy({ $0 == mutationInputFilename || $0 == mutationOutputFilename })
    else { throw InspectionFailure.unsafeWorkspace }
    return workspace
}

func readProtectionRequestFromStandardInput() throws -> Data {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while true {
        let count = read(STDIN_FILENO, &buffer, buffer.count)
        guard count >= 0 else { throw InspectionFailure.invalidRequest }
        if count == 0 { break }
        guard data.count <= maxRequestBytes - count else { throw InspectionFailure.requestTooLarge }
        data.append(buffer, count: count)
    }
    guard String(data: data, encoding: .utf8) != nil else { throw InspectionFailure.invalidRequest }
    return data
}

func readPrivateRequest(_ url: URL) throws -> Data {
    var expected = stat()
    guard lstat(url.path, &expected) == 0,
          (expected.st_mode & S_IFMT) == S_IFREG,
          (expected.st_mode & 0o077) == 0,
          expected.st_nlink == 1,
          expected.st_size >= 0
    else { throw InspectionFailure.unsafeWorkspace }
    guard expected.st_size <= off_t(maxRequestBytes) else { throw InspectionFailure.requestTooLarge }

    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw InspectionFailure.unsafeWorkspace }
    defer { close(descriptor) }

    var information = stat()
    guard fstat(descriptor, &information) == 0,
          (information.st_mode & S_IFMT) == S_IFREG,
          (information.st_mode & 0o077) == 0,
          information.st_nlink == 1,
          information.st_size >= 0,
          information.st_dev == expected.st_dev,
          information.st_ino == expected.st_ino
    else { throw InspectionFailure.unsafeWorkspace }
    guard information.st_size <= off_t(maxRequestBytes) else { throw InspectionFailure.requestTooLarge }

    var buffer = [UInt8](repeating: 0, count: maxRequestBytes + 1)
    let bytesRead = read(descriptor, &buffer, buffer.count)
    guard bytesRead >= 0 else { throw InspectionFailure.unsafeWorkspace }
    guard bytesRead <= maxRequestBytes else { throw InspectionFailure.requestTooLarge }
    return Data(buffer.prefix(Int(bytesRead)))
}

func readPrivateInput(_ url: URL) throws -> Data {
    var expected = stat()
    guard lstat(url.path, &expected) == 0,
          (expected.st_mode & S_IFMT) == S_IFREG,
          (expected.st_mode & 0o077) == 0,
          expected.st_nlink == 1,
          expected.st_size > 0
    else { throw InspectionFailure.unsafeWorkspace }
    guard expected.st_size <= off_t(maxInputBytes) else { throw InspectionFailure.inputTooLarge }

    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw InspectionFailure.unsafeWorkspace }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }

    var information = stat()
    guard fstat(descriptor, &information) == 0,
          (information.st_mode & S_IFMT) == S_IFREG,
          (information.st_mode & 0o077) == 0,
          information.st_nlink == 1,
          information.st_size > 0,
          information.st_size <= off_t(maxInputBytes),
          information.st_dev == expected.st_dev,
          information.st_ino == expected.st_ino
    else { throw InspectionFailure.unsafeWorkspace }

    var data = Data()
    data.reserveCapacity(Int(information.st_size))
    do {
        while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
            guard data.count <= maxInputBytes - chunk.count else { throw InspectionFailure.inputTooLarge }
            data.append(chunk)
        }
    } catch let failure as InspectionFailure {
        throw failure
    } catch {
        throw InspectionFailure.unsafeWorkspace
    }
    guard data.count == Int(information.st_size) else { throw InspectionFailure.unsafeWorkspace }

    var finalInformation = stat()
    guard fstat(descriptor, &finalInformation) == 0,
          finalInformation.st_dev == information.st_dev,
          finalInformation.st_ino == information.st_ino,
          finalInformation.st_size == information.st_size,
          finalInformation.st_mtimespec.tv_sec == information.st_mtimespec.tv_sec,
          finalInformation.st_mtimespec.tv_nsec == information.st_mtimespec.tv_nsec,
          finalInformation.st_ctimespec.tv_sec == information.st_ctimespec.tv_sec,
          finalInformation.st_ctimespec.tv_nsec == information.st_ctimespec.tv_nsec
    else { throw InspectionFailure.unsafeWorkspace }
    return data
}

