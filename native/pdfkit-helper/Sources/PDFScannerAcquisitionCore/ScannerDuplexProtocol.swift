import Foundation

public struct ScannerDuplexRequest: Equatable {
    public let version: Int
    public let operation: String
    public let deviceID: String
    public let destination: String
    public let maxBytes: Int
    public let maxPixels: Int
    public let deadlineMS: Int
    public let format: ScannerFormat
    public let source: ScannerSource
    public let duplex: Bool
    public let color: ScannerColor
    public let dpi: Int
    public let pageCount: Int

    public init(version: Int = 1, operation: String = "scanDuplex", deviceID: String,
                destination: String, maxBytes: Int, maxPixels: Int, deadlineMS: Int,
                format: ScannerFormat = .pdf, source: ScannerSource = .feeder,
                duplex: Bool = true, color: ScannerColor = .color, dpi: Int = 300,
                pageCount: Int) {
        self.version = version
        self.operation = operation
        self.deviceID = deviceID
        self.destination = destination
        self.maxBytes = maxBytes
        self.maxPixels = maxPixels
        self.deadlineMS = deadlineMS
        self.format = format
        self.source = source
        self.duplex = duplex
        self.color = color
        self.dpi = dpi
        self.pageCount = pageCount
    }
}

public struct ScannerDuplexPageResult: Codable, Equatable {
    public let sequence: Int
    public let sheet: Int
    public let side: String
    public let width: Int
    public let height: Int
    public let pixels: Int
    public let digest: String

    public init(sequence: Int, sheet: Int, side: String, width: Int, height: Int,
                pixels: Int, digest: String) {
        self.sequence = sequence
        self.sheet = sheet
        self.side = side
        self.width = width
        self.height = height
        self.pixels = pixels
        self.digest = digest
    }
}

public struct ScannerDuplexEvidence: Codable, Equatable {
    public let api: String
    public let discoveryAttempted: Bool
    public let liveVerification: Bool
    public let scanSupport: String
    public let persistentIdentityVerified: Bool
    public let feederSupportAdvertised: Bool

    public init() {
        api = "ImageCaptureCore"
        discoveryAttempted = true
        liveVerification = true
        scanSupport = "duplex-feeder-supported"
        persistentIdentityVerified = true
        feederSupportAdvertised = true
    }
}

public struct ScannerDuplexResult: Codable, Equatable {
    public let outputName: String
    public let format: ScannerFormat
    public let pageCount: Int
    public let bytes: Int
    public let digest: String
    public let pages: [ScannerDuplexPageResult]
    public let evidence: ScannerDuplexEvidence

    public init(outputName: String = "duplex-scan.pdf", format: ScannerFormat = .pdf,
                pageCount: Int, bytes: Int, digest: String,
                pages: [ScannerDuplexPageResult], evidence: ScannerDuplexEvidence = .init()) {
        self.outputName = outputName
        self.format = format
        self.pageCount = pageCount
        self.bytes = bytes
        self.digest = digest
        self.pages = pages
        self.evidence = evidence
    }
}

public struct ScannerDuplexEnvelope: Codable, Equatable {
    public let version: Int
    public let ok: Bool
    public let result: ScannerDuplexResult?
    public let error: ScannerUnsupportedResult?

    public init(version: Int = 1, ok: Bool, result: ScannerDuplexResult? = nil,
                error: ScannerUnsupportedResult? = nil) {
        self.version = version
        self.ok = ok
        self.result = result
        self.error = error
    }
}

func parseScannerDuplexRequest(_ dictionary: [String: Any]) throws -> ScannerDuplexRequest {
    let keys: Set<String> = ["version", "operation", "deviceId", "destination", "maxBytes",
                             "maxPixels", "deadlineMs", "format", "source", "duplex", "color",
                             "dpi", "pageCount"]
    guard Set(dictionary.keys) == keys,
          let version = strictInteger(dictionary["version"]), version == 1,
          dictionary["operation"] as? String == "scanDuplex",
          let deviceID = dictionary["deviceId"] as? String, validOpaqueID(deviceID),
          let destination = dictionary["destination"] as? String, validDestinationString(destination),
          let maxBytes = strictInteger(dictionary["maxBytes"]), (1...(64 * 1024 * 1024)).contains(maxBytes),
          let maxPixels = strictInteger(dictionary["maxPixels"]), (1...500_000_000).contains(maxPixels),
          let deadlineMS = strictInteger(dictionary["deadlineMs"]), (1...120_000).contains(deadlineMS),
          let formatValue = dictionary["format"] as? String,
          let format = ScannerFormat(rawValue: formatValue), format == .pdf,
          let sourceValue = dictionary["source"] as? String,
          let source = ScannerSource(rawValue: sourceValue), source == .feeder,
          let duplex = dictionary["duplex"] as? Bool, duplex,
          let colorValue = dictionary["color"] as? String,
          let color = ScannerColor(rawValue: colorValue),
          let dpi = strictInteger(dictionary["dpi"]), [150, 300, 600].contains(dpi),
          let pageCount = strictInteger(dictionary["pageCount"]),
          (2...50).contains(pageCount), pageCount.isMultiple(of: 2)
    else { throw ScannerProtocolError.invalidRequest }
    return ScannerDuplexRequest(version: version, deviceID: deviceID, destination: destination,
                                maxBytes: maxBytes, maxPixels: maxPixels, deadlineMS: deadlineMS,
                                format: format, source: source, duplex: duplex, color: color,
                                dpi: dpi, pageCount: pageCount)
}

public func unsupportedDuplexEnvelope(
    code: String = "SCANNER_DUPLEX_UNSUPPORTED",
    reason: String = "The scanner did not advertise a supported duplex document feeder."
) -> ScannerDuplexEnvelope {
    ScannerDuplexEnvelope(ok: false, error: ScannerUnsupportedResult(
        code: code,
        reason: reason,
        evidence: ScannerEvidence(discoveryAttempted: false)
    ))
}
