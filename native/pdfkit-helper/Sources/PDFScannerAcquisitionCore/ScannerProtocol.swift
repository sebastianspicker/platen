import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

public enum ScannerProtocolError: Error, Equatable {
    case invalidRequest
    case requestTooLarge
    case invalidDestination
    case scanUnsupported
    case deadlineExceeded
}

public enum ScannerSource: String, Codable, Equatable {
    case flatbed = "flatbed"
    case feeder = "feeder"
}

public enum ScannerColor: String, Codable, Equatable {
    case blackAndWhite = "bw"
    case grayscale = "gray"
    case color = "color"
}

public enum ScannerFormat: String, Codable, Equatable {
    case tiff = "TIFF"
    case jpeg = "JPEG"
    case pdf = "PDF"
}

public struct ScannerListRequest: Equatable {
    public let version: Int
    public let operation: String

    public init(version: Int = 1, operation: String = "list") {
        self.version = version
        self.operation = operation
    }
}

public struct ScannerScanRequest: Equatable {
    public let version: Int
    public let operation: String
    public let deviceID: String
    public let destination: String
    public let page: Int
    public let maxBytes: Int
    public let deadlineMS: Int
    public let format: ScannerFormat
    public let source: ScannerSource
    public let duplex: Bool
    public let color: ScannerColor
    public let dpi: Int
    public let pageCount: Int

    public init(version: Int = 1, operation: String = "scan", deviceID: String, destination: String, page: Int, maxBytes: Int, deadlineMS: Int, format: ScannerFormat, source: ScannerSource = .flatbed, duplex: Bool = false, color: ScannerColor = .color, dpi: Int = 300, pageCount: Int = 1) {
        self.version = version
        self.operation = operation
        self.deviceID = deviceID
        self.destination = destination
        self.page = page
        self.maxBytes = maxBytes
        self.deadlineMS = deadlineMS
        self.format = format
        self.source = source
        self.duplex = duplex
        self.color = color
        self.dpi = dpi
        self.pageCount = pageCount
    }
}

public enum ScannerRequest: Equatable {
    case list(ScannerListRequest)
    case scan(ScannerScanRequest)
    case scanDuplex(ScannerDuplexRequest)
}

public enum ScannerFramedLine: Equatable {
    case line(Data)
    case oversized
}

public struct ScannerLineFramer {
    private let maximumFrameBytes: Int
    private var buffer = Data()
    private var discarding = false

    public init(maximumFrameBytes: Int = 16 * 1024) {
        self.maximumFrameBytes = maximumFrameBytes
    }

    public mutating func append(_ chunk: Data) -> [ScannerFramedLine] {
        var frames: [ScannerFramedLine] = []
        for byte in chunk {
            if byte == 0x0a {
                if discarding { frames.append(.oversized) }
                else {
                    var line = buffer
                    if line.last == 0x0d { line.removeLast() }
                    frames.append(.line(line))
                }
                buffer.removeAll(keepingCapacity: true)
                discarding = false
            } else if !discarding {
                if buffer.count >= maximumFrameBytes { buffer.removeAll(keepingCapacity: true); discarding = true }
                else { buffer.append(byte) }
            }
        }
        return frames
    }

    public mutating func finish() -> [ScannerFramedLine] {
        guard !buffer.isEmpty || discarding else { return [] }
        defer { buffer.removeAll(keepingCapacity: true); discarding = false }
        return [discarding ? .oversized : .line(buffer)]
    }
}

public struct ScannerDevice: Codable, Equatable {
    public let id: String
    public let name: String
    public let kind: String
    public let capabilities: [String]

    public init(id: String, name: String, kind: String = "scanner", capabilities: [String] = ["image-acquisition-discovery"]) {
        self.id = id
        self.name = name
        self.kind = kind
        self.capabilities = capabilities
    }
}

public struct ScannerEvidence: Codable, Equatable {
    public let api: String
    public let discoveryAttempted: Bool
    public let liveVerification: Bool
    public let scanSupport: String

    public init(api: String = "ImageCaptureCore", discoveryAttempted: Bool, liveVerification: Bool = false, scanSupport: String = "unsupported") {
        self.api = api
        self.discoveryAttempted = discoveryAttempted
        self.liveVerification = liveVerification
        self.scanSupport = scanSupport
    }
}

public struct ScannerListResult: Codable, Equatable {
    public let devices: [ScannerDevice]
    public let evidence: ScannerEvidence

    public init(devices: [ScannerDevice], evidence: ScannerEvidence) {
        self.devices = devices
        self.evidence = evidence
    }
}

public struct ScannerUnsupportedResult: Codable, Equatable {
    public let code: String
    public let reason: String
    public let evidence: ScannerEvidence

    public init(code: String, reason: String, evidence: ScannerEvidence) {
        self.code = code
        self.reason = reason
        self.evidence = evidence
    }
}

public struct ScannerScanResult: Codable, Equatable {
    public let outputName: String
    public let format: ScannerFormat
    public let pageCount: Int
    public let bytes: Int
    public let digest: String
    public let evidence: ScannerEvidence

    public init(outputName: String, format: ScannerFormat, pageCount: Int, bytes: Int, digest: String, evidence: ScannerEvidence) {
        self.outputName = outputName
        self.format = format
        self.pageCount = pageCount
        self.bytes = bytes
        self.digest = digest
        self.evidence = evidence
    }
}

public struct ScannerScanEnvelope: Codable, Equatable {
    public let version: Int
    public let ok: Bool
    public let result: ScannerScanResult?
    public let error: ScannerUnsupportedResult?

    public init(version: Int = 1, ok: Bool, result: ScannerScanResult? = nil, error: ScannerUnsupportedResult? = nil) {
        self.version = version
        self.ok = ok
        self.result = result
        self.error = error
    }
}

public struct ScannerEnvelope: Codable, Equatable {
    public let version: Int
    public let ok: Bool
    public let result: ScannerListResult?
    public let error: ScannerUnsupportedResult?

    public init(version: Int = 1, ok: Bool, result: ScannerListResult? = nil, error: ScannerUnsupportedResult? = nil) {
        self.version = version
        self.ok = ok
        self.result = result
        self.error = error
    }
}

private let maximumRequestBytes = 16 * 1024
private let maximumPage = 1_000
private let maximumBytes = 64 * 1024 * 1024
private let maximumDeadlineMS = 120_000
private let allowedDPIs: Set<Int> = [150, 300, 600]
private let allowedFormats: Set<ScannerFormat> = [.pdf]

public func parseScannerRequest(_ data: Data) throws -> ScannerRequest {
    guard data.count <= maximumRequestBytes else { throw ScannerProtocolError.requestTooLarge }
    guard let keys = topLevelObjectKeys(data), Set(keys).count == keys.count else { throw ScannerProtocolError.invalidRequest }
    guard let object = try? JSONSerialization.jsonObject(with: data), let dictionary = object as? [String: Any] else { throw ScannerProtocolError.invalidRequest }
    guard let version = strictInteger(dictionary["version"]), version == 1, let operation = dictionary["operation"] as? String else { throw ScannerProtocolError.invalidRequest }
    switch operation {
    case "list":
        guard Set(dictionary.keys) == ["version", "operation"] else { throw ScannerProtocolError.invalidRequest }
        return .list(ScannerListRequest(version: version, operation: operation))
    case "scan":
        guard Set(dictionary.keys) == ["version", "operation", "deviceId", "destination", "page", "maxBytes", "deadlineMs", "format", "source", "duplex", "color", "dpi", "pageCount"],
              let deviceID = dictionary["deviceId"] as? String,
              let destination = dictionary["destination"] as? String,
              let page = strictInteger(dictionary["page"]),
              let maxBytes = strictInteger(dictionary["maxBytes"]),
              let deadlineMS = strictInteger(dictionary["deadlineMs"]),
              let formatValue = dictionary["format"] as? String,
              let sourceValue = dictionary["source"] as? String,
              let source = ScannerSource(rawValue: sourceValue),
              let duplex = dictionary["duplex"] as? Bool,
              let colorValue = dictionary["color"] as? String,
              let color = ScannerColor(rawValue: colorValue),
              let dpi = strictInteger(dictionary["dpi"]),
              let pageCount = strictInteger(dictionary["pageCount"]),
              let format = ScannerFormat(rawValue: formatValue),
              validOpaqueID(deviceID), validDestinationString(destination),
              (1...maximumPage).contains(page), (1...maximumBytes).contains(maxBytes), (1...maximumDeadlineMS).contains(deadlineMS),
              allowedDPIs.contains(dpi), allowedFormats.contains(format), source == .flatbed,
              pageCount == 1, duplex == false
        else { throw ScannerProtocolError.invalidRequest }
        return .scan(ScannerScanRequest(version: version, operation: operation, deviceID: deviceID, destination: destination, page: page, maxBytes: maxBytes, deadlineMS: deadlineMS, format: format, source: source, duplex: duplex, color: color, dpi: dpi, pageCount: pageCount))
    case "scanDuplex":
        return .scanDuplex(try parseScannerDuplexRequest(dictionary))
    default:
        throw ScannerProtocolError.invalidRequest
    }
}

func strictInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber else { return nil }
    let type = String(cString: number.objCType)
    guard type != "c", type != "B", type != "d", type != "f" else { return nil }
    let value = number.doubleValue
    guard value.isFinite, value.rounded() == value, value >= Double(Int.min), value <= Double(Int.max) else { return nil }
    let integer = number.intValue
    return Double(integer) == value ? integer : nil
}

private func topLevelObjectKeys(_ data: Data) -> [String]? {
    let bytes = Array(data); var index = 0
    func whitespace(_ byte: UInt8) -> Bool { byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0d }
    func skipWhitespace() { while index < bytes.count && whitespace(bytes[index]) { index += 1 } }
    func skipString() -> Data? {
        guard index < bytes.count, bytes[index] == 0x22 else { return nil }
        let start = index; index += 1; var escaped = false
        while index < bytes.count {
            let byte = bytes[index]; index += 1
            if escaped { escaped = false; continue }
            if byte == 0x5c { escaped = true; continue }
            if byte == 0x22 { return Data(bytes[start..<index]) }
            if byte < 0x20 { return nil }
        }
        return nil
    }
    func skipValue() -> Bool {
        skipWhitespace(); guard index < bytes.count else { return false }
        if bytes[index] == 0x22 { return skipString() != nil }
        if bytes[index] == 0x7b || bytes[index] == 0x5b {
            let opening = bytes[index]; let closing: UInt8 = opening == 0x7b ? 0x7d : 0x5d; index += 1; skipWhitespace()
            if index < bytes.count, bytes[index] == closing { index += 1; return true }
            while index < bytes.count {
                if opening == 0x7b { guard skipString() != nil else { return false }; skipWhitespace(); guard index < bytes.count, bytes[index] == 0x3a else { return false }; index += 1 }
                guard skipValue() else { return false }; skipWhitespace()
                if index < bytes.count, bytes[index] == closing { index += 1; return true }
                guard index < bytes.count, bytes[index] == 0x2c else { return false }; index += 1; skipWhitespace()
            }
            return false
        }
        let start = index
        while index < bytes.count && !whitespace(bytes[index]) && bytes[index] != 0x2c && bytes[index] != 0x5d && bytes[index] != 0x7d { index += 1 }
        return index > start
    }
    skipWhitespace(); guard index < bytes.count, bytes[index] == 0x7b else { return nil }; index += 1; skipWhitespace()
    var keys: [String] = []
    if index < bytes.count, bytes[index] == 0x7d { return keys }
    while index < bytes.count {
        guard let raw = skipString(), raw.count >= 2 else { return nil }
        let keyBytes = raw.dropFirst().dropLast()
        guard !keyBytes.contains(0x5c), let key = String(bytes: keyBytes, encoding: .utf8) else { return nil }
        if keys.contains(key) { return nil }
        keys.append(key); skipWhitespace(); guard index < bytes.count, bytes[index] == 0x3a else { return nil }; index += 1
        guard skipValue() else { return nil }; skipWhitespace()
        if index < bytes.count, bytes[index] == 0x7d { index += 1; skipWhitespace(); return index == bytes.count ? keys : nil }
        guard index < bytes.count, bytes[index] == 0x2c else { return nil }; index += 1; skipWhitespace()
    }
    return nil
}

public func validOpaqueID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && value.unicodeScalars.allSatisfy { scalar in
        let code = scalar.value
        return scalar == "-" || scalar == "_" || scalar == "."
            || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    }
}

public func validDestinationString(_ value: String) -> Bool {
    guard value.utf8.count <= 4_096, value.hasPrefix("/"), !value.contains("\0"), !value.contains("..") else { return false }
    return value == URL(fileURLWithPath: value).standardizedFileURL.path
}

public func validatePrivateDestination(_ url: URL, fileManager: FileManager = .default) -> Bool {
    let path = url.path
    guard validDestinationString(path), fileManager.fileExists(atPath: path), let attributes = try? fileManager.attributesOfItem(atPath: path),
          (attributes[.type] as? FileAttributeType) == .typeDirectory,
          let permissions = attributes[.posixPermissions] as? NSNumber, permissions.intValue & 0o777 == 0o700,
          let owner = attributes[.ownerAccountID] as? NSNumber, owner.uint32Value == getuid() else { return false }
    return url.resolvingSymlinksInPath().path == url.standardizedFileURL.path
}

public func validateScannerImageInput(_ url: URL, workspace: URL, maximumBytes: Int, fileManager: FileManager = .default) -> Bool {
    guard maximumBytes > 0, validDestinationString(workspace.path), validatePrivateDestination(workspace, fileManager: fileManager), url.path != workspace.appendingPathComponent("scan.pdf").path,
          url.deletingLastPathComponent().standardizedFileURL.path == workspace.standardizedFileURL.path,
          url.path == url.standardizedFileURL.path, url.resolvingSymlinksInPath().path == url.path,
          fileManager.fileExists(atPath: url.path), let attributes = try? fileManager.attributesOfItem(atPath: url.path),
          (attributes[.type] as? FileAttributeType) == .typeRegular,
          let permissions = attributes[.posixPermissions] as? NSNumber, permissions.intValue & 0o777 == 0o600,
          let owner = attributes[.ownerAccountID] as? NSNumber, owner.uint32Value == getuid(),
          let links = attributes[.referenceCount] as? NSNumber, links.intValue == 1,
          let size = attributes[.size] as? NSNumber, size.intValue > 0, size.intValue <= maximumBytes else { return false }
    return true
}

public func sanitizedScannerName(_ value: String?) -> String {
    let source = value ?? "Scanner"
    let scalars = source.unicodeScalars.map { scalar -> Unicode.Scalar in
        switch scalar.properties.generalCategory {
        case .control, .format, .surrogate, .privateUse, .unassigned: return "_"
        default: return scalar
        }
    }
    var name = String(String.UnicodeScalarView(scalars).prefix(80)).trimmingCharacters(in: .whitespacesAndNewlines)
    while name.utf8.count > 256 { name.removeLast() }
    return name.isEmpty ? "Scanner" : name
}

public func unsupportedScanEnvelope() -> ScannerEnvelope {
    ScannerEnvelope(ok: false, error: ScannerUnsupportedResult(code: "SCANNER_SCAN_UNSUPPORTED", reason: "Safe bounded image acquisition is not implemented; discovery-only mode is available.", evidence: ScannerEvidence(discoveryAttempted: false)))
}

public func unsupportedAcquisitionEnvelope(code: String = "SCANNER_SCAN_UNSUPPORTED", reason: String = "Safe bounded image acquisition is unavailable for this scanner or platform.") -> ScannerScanEnvelope {
    ScannerScanEnvelope(ok: false, error: ScannerUnsupportedResult(code: code, reason: reason, evidence: ScannerEvidence(discoveryAttempted: false)))
}
