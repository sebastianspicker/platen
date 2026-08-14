import Foundation

#if canImport(ImageCaptureCore) && canImport(ImageIO) && canImport(CoreGraphics) && canImport(CryptoKit)
import CoreGraphics
import CryptoKit
import ImageCaptureCore
import ImageIO
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

private final class AcquisitionBrowserDelegate: NSObject, ICDeviceBrowserDelegate {
    var devices: [ICScannerDevice] = []
    var enumerated = false

    func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        guard let scanner = device as? ICScannerDevice, device.type.rawValue & ICDeviceTypeMask.scanner.rawValue != 0 else { return }
        devices.append(scanner)
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        devices.removeAll { $0 === device }
    }

    func deviceBrowserDidEnumerateLocalDevices(_ browser: ICDeviceBrowser) { enumerated = true }
}

private final class AcquisitionDelegate: NSObject, ICScannerDeviceDelegate {
    var scanURL: URL?
    var openError: Error?
    var scanError: Error?
    var opened = false
    var completed = false

    func device(_ device: ICDevice, didOpenSessionWithError error: Error?) {
        openError = error
        opened = true
    }

    func device(_ device: ICDevice, didCloseSessionWithError error: Error?) {}
    func didRemove(_ device: ICDevice) { scanError = ScannerAcquisitionError.deviceRemoved }

    func scannerDevice(_ scanner: ICScannerDevice, didScanTo url: URL) { scanURL = url }

    func scannerDevice(_ scanner: ICScannerDevice, didCompleteScanWithError error: Error?) {
        scanError = error
        completed = true
    }
}

private enum ScannerAcquisitionError: Error {
    case deviceUnavailable
    case deviceRemoved
    case scanFailed
    case outputInvalid
    case deadlineExceeded
}

private struct StableImageStat: Equatable {
    let device: UInt64
    let inode: UInt64
    let links: UInt64
    let size: Int
    let mode: UInt32
    let owner: UInt32
    let modified: Int64
    let changed: Int64
}

private func stableImageStat(_ descriptor: Int32) -> StableImageStat? {
    var value = stat()
    guard fstat(descriptor, &value) == 0, value.st_size > 0, value.st_size <= off_t(Int.max) else { return nil }
#if canImport(Darwin)
    return StableImageStat(device: UInt64(value.st_dev), inode: UInt64(value.st_ino), links: UInt64(value.st_nlink), size: Int(value.st_size), mode: UInt32(value.st_mode), owner: UInt32(value.st_uid), modified: Int64(value.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(value.st_mtimespec.tv_nsec), changed: Int64(value.st_ctimespec.tv_sec) * 1_000_000_000 + Int64(value.st_ctimespec.tv_nsec))
#else
    return StableImageStat(device: UInt64(value.st_dev), inode: UInt64(value.st_ino), links: UInt64(value.st_nlink), size: Int(value.st_size), mode: UInt32(value.st_mode), owner: UInt32(value.st_uid), modified: Int64(value.st_mtim.tv_sec) * 1_000_000_000 + Int64(value.st_mtim.tv_nsec), changed: Int64(value.st_ctim.tv_sec) * 1_000_000_000 + Int64(value.st_ctim.tv_nsec))
#endif
}

func readStableScannerImage(_ url: URL, workspace: URL, maximumBytes: Int) throws -> Data {
    guard validateScannerImageInput(url, workspace: workspace, maximumBytes: maximumBytes) else { throw ScannerAcquisitionError.outputInvalid }
    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw ScannerAcquisitionError.outputInvalid }
    defer { close(descriptor) }
    guard let before = stableImageStat(descriptor), before.links == 1, before.mode & 0o777 == 0o600, before.owner == UInt32(getuid()), before.size <= maximumBytes else { throw ScannerAcquisitionError.outputInvalid }
    var bytes = Data(count: before.size)
    try bytes.withUnsafeMutableBytes { raw in
        var offset = 0
        while offset < before.size {
            let count = read(descriptor, raw.baseAddress!.advanced(by: offset), before.size - offset)
            guard count > 0 else { throw ScannerAcquisitionError.outputInvalid }
            offset += count
        }
        var trailing: UInt8 = 0
        guard read(descriptor, &trailing, 1) == 0 else { throw ScannerAcquisitionError.outputInvalid }
    }
    guard let after = stableImageStat(descriptor), after == before else { throw ScannerAcquisitionError.outputInvalid }
    return bytes
}

func scannerOpaqueID(_ scanner: ICScannerDevice) -> String? {
    guard let persistent = scanner.persistentIDString, !persistent.isEmpty else { return nil }
    let digest = SHA256.hash(data: Data(persistent.utf8)).map { String(format: "%02x", $0) }.joined()
    return "scanner-" + String(digest.prefix(32))
}

func runLoop(until deadline: Date, done: () -> Bool) -> Bool {
    while !done() && Date() < deadline {
        _ = RunLoop.current.run(mode: .default, before: min(deadline, Date().addingTimeInterval(0.025)))
    }
    return done()
}

func discoverDevice(id: String, deadline: Date) throws -> ICScannerDevice {
    let delegate = AcquisitionBrowserDelegate()
    let browser = ICDeviceBrowser()
    browser.delegate = delegate
    browser.browsedDeviceTypeMask = .scanner
    browser.start()
    defer { browser.stop() }
    guard runLoop(until: min(deadline, Date().addingTimeInterval(0.5)), done: { delegate.enumerated }) else {
        throw ScannerAcquisitionError.deviceUnavailable
    }
    guard let scanner = delegate.devices.first(where: { scannerOpaqueID($0) == id }) else {
        throw ScannerAcquisitionError.deviceUnavailable
    }
    return scanner
}

private func configure(_ scanner: ICScannerDevice, request: ScannerScanRequest) throws {
    guard request.source == .flatbed, request.duplex == false, request.pageCount == 1 else { throw ScannerAcquisitionError.scanFailed }
    scanner.transferMode = .fileBased
    scanner.documentName = "pdfkit-scan"
    scanner.documentUTI = "public.jpeg"
    guard let unit = scanner.selectedFunctionalUnit as? ICScannerFunctionalUnitFlatbed else { throw ScannerAcquisitionError.scanFailed }
    guard unit.supportedResolutions.contains(request.dpi) else { throw ScannerAcquisitionError.scanFailed }
    unit.resolution = request.dpi
    guard let bits = ICScannerBitDepth(rawValue: 8), unit.supportedBitDepths.contains(8) else { throw ScannerAcquisitionError.scanFailed }
    unit.bitDepth = bits
    switch request.color {
    case .blackAndWhite: unit.pixelDataType = .BW
    case .grayscale: unit.pixelDataType = .gray
    case .color: unit.pixelDataType = .RGB
    }
}

private func writePDF(from imageData: Data, to destination: URL, maximumBytes: Int, deadline: Date) throws {
    guard Date() < deadline, let source = CGImageSourceCreateWithData(imageData as CFData, nil), let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any], let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue, let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue, width > 0, height > 0, width <= 20_000, height <= 20_000, Int64(width) * Int64(height) <= 100_000_000, let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw ScannerAcquisitionError.outputInvalid }
    var box = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    let pdfData = NSMutableData()
    guard let consumer = CGDataConsumer(data: pdfData), let context = CGContext(consumer: consumer, mediaBox: &box, nil) else { throw ScannerAcquisitionError.outputInvalid }
    context.beginPDFPage(nil)
    context.draw(image, in: box)
    context.endPDFPage()
    context.closePDF()
    guard Date() < deadline, pdfData.length > 5, pdfData.length <= maximumBytes, (pdfData as Data).starts(with: Data("%PDF-".utf8)) else { throw ScannerAcquisitionError.outputInvalid }
    let descriptor = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw ScannerAcquisitionError.outputInvalid }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    try handle.write(contentsOf: pdfData as Data)
    try handle.synchronize()
}

public func acquireScannerPage(_ request: ScannerScanRequest) throws -> ScannerScanResult {
    guard request.format == .pdf, request.source == .flatbed, request.duplex == false, request.pageCount == 1 else { throw ScannerAcquisitionError.scanFailed }
    let workspace = URL(fileURLWithPath: request.destination, isDirectory: true)
    guard validatePrivateDestination(workspace) else { throw ScannerProtocolError.invalidDestination }
    let deadline = Date().addingTimeInterval(Double(request.deadlineMS) / 1_000)
    let scanner = try discoverDevice(id: request.deviceID, deadline: deadline)
    let delegate = AcquisitionDelegate()
    scanner.delegate = delegate
    scanner.requestOpenSession()
    guard runLoop(until: deadline, done: { delegate.opened }) && delegate.openError == nil else { throw ScannerAcquisitionError.deviceUnavailable }
    defer { scanner.requestCloseSession() }
    try configure(scanner, request: request)
    scanner.downloadsDirectory = workspace
    scanner.requestScan()
    guard runLoop(until: deadline, done: { delegate.completed }) && delegate.scanError == nil, let imageURL = delegate.scanURL else {
        scanner.cancelScan()
        throw ScannerAcquisitionError.deadlineExceeded
    }
    let imageData = try readStableScannerImage(imageURL, workspace: workspace, maximumBytes: request.maxBytes)
    guard Date() < deadline else { throw ScannerAcquisitionError.deadlineExceeded }
    let outputURL = workspace.appendingPathComponent("scan.pdf", isDirectory: false)
    guard !FileManager.default.fileExists(atPath: outputURL.path), Date() < deadline else { throw ScannerAcquisitionError.outputInvalid }
    try writePDF(from: imageData, to: outputURL, maximumBytes: request.maxBytes, deadline: deadline)
    try? FileManager.default.removeItem(at: imageURL)
    guard Date() < deadline else { try? FileManager.default.removeItem(at: outputURL); throw ScannerAcquisitionError.deadlineExceeded }
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outputURL.path)
    let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
    guard let size = attributes[.size] as? NSNumber, size.intValue > 0, size.intValue <= request.maxBytes else { try? FileManager.default.removeItem(at: outputURL); throw ScannerAcquisitionError.outputInvalid }
    let data = try Data(contentsOf: outputURL, options: [.mappedIfSafe])
    guard data.count == size.intValue, data.starts(with: Data("%PDF-".utf8)) else { try? FileManager.default.removeItem(at: outputURL); throw ScannerAcquisitionError.outputInvalid }
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    return ScannerScanResult(outputName: "scan.pdf", format: .pdf, pageCount: 1, bytes: data.count, digest: digest, evidence: ScannerEvidence(discoveryAttempted: true, liveVerification: true, scanSupport: "supported"))
}

#else

public func acquireScannerPage(_ request: ScannerScanRequest) throws -> ScannerScanResult {
    throw ScannerProtocolError.scanUnsupported
}

#endif
