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

private final class DuplexAcquisitionDelegate: NSObject, ICScannerDeviceDelegate {
    var openError: Error?
    var selectionError: Error?
    var scanError: Error?
    var opened = false
    var selected = false
    var completed = false
    var overflow = false
    var maximumPages = 0
    var scanURLs: [URL] = []

    func device(_ device: ICDevice, didOpenSessionWithError error: Error?) {
        openError = error
        opened = true
    }

    func device(_ device: ICDevice, didCloseSessionWithError error: Error?) {}
    func didRemove(_ device: ICDevice) { scanError = ScannerDuplexAcquisitionError.deviceRemoved }

    func scannerDevice(_ scanner: ICScannerDevice, didSelect functionalUnit: ICScannerFunctionalUnit,
                       error: Error?) {
        selectionError = error
        selected = true
    }

    func scannerDevice(_ scanner: ICScannerDevice, didScanTo url: URL) {
        if scanURLs.count >= maximumPages {
            overflow = true
            scanner.cancelScan()
            return
        }
        scanURLs.append(url)
    }

    func scannerDevice(_ scanner: ICScannerDevice, didCompleteScanWithError error: Error?) {
        scanError = error
        completed = true
    }
}

private enum ScannerDuplexAcquisitionError: Error {
    case deviceRemoved
    case unavailable
    case scanFailed
    case outputInvalid
    case deadlineExceeded
}

private struct DecodedDuplexPage {
    let image: CGImage
    let metadata: ScannerDuplexPageResult
}

private func configureDuplex(_ scanner: ICScannerDevice, request: ScannerDuplexRequest,
                             delegate: DuplexAcquisitionDelegate, deadline: Date) throws {
    guard scanner.availableFunctionalUnitTypes.contains(NSNumber(value: ICScannerFunctionalUnitType.documentFeeder.rawValue))
    else { throw ScannerProtocolError.scanUnsupported }
    delegate.selected = false
    scanner.requestSelect(.documentFeeder)
    guard runLoop(until: deadline, done: { delegate.selected }), delegate.selectionError == nil,
          let unit = scanner.selectedFunctionalUnit as? ICScannerFunctionalUnitDocumentFeeder,
          unit.supportsDuplexScanning, !unit.reverseFeederPageOrder, unit.documentLoaded
    else { throw ScannerProtocolError.scanUnsupported }
    scanner.transferMode = .fileBased
    scanner.documentName = "pdfkit-duplex-scan"
    scanner.documentUTI = "public.jpeg"
    guard unit.supportedResolutions.contains(request.dpi) else {
        throw ScannerProtocolError.scanUnsupported
    }
    unit.resolution = request.dpi
    guard let bits = ICScannerBitDepth(rawValue: 8), unit.supportedBitDepths.contains(8) else {
        throw ScannerProtocolError.scanUnsupported
    }
    unit.bitDepth = bits
    unit.duplexScanningEnabled = true
    guard unit.duplexScanningEnabled else { throw ScannerProtocolError.scanUnsupported }
    switch request.color {
    case .blackAndWhite: unit.pixelDataType = .BW
    case .grayscale: unit.pixelDataType = .gray
    case .color: unit.pixelDataType = .RGB
    }
}

private func decodeDuplexPages(_ urls: [URL], workspace: URL,
                               request: ScannerDuplexRequest, deadline: Date) throws -> [DecodedDuplexPage] {
    var pages: [DecodedDuplexPage] = []
    var remainingBytes = request.maxBytes
    var totalPixels: Int64 = 0
    var expectedSize: (Int, Int)?
    for (index, url) in urls.enumerated() {
        guard Date() < deadline, remainingBytes > 0 else {
            throw ScannerDuplexAcquisitionError.deadlineExceeded
        }
        let data = try readStableScannerImage(url, workspace: workspace, maximumBytes: remainingBytes)
        remainingBytes -= data.count
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              width > 0, height > 0, width <= 20_000, height <= 20_000,
              Int64(width) * Int64(height) <= 100_000_000,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { throw ScannerDuplexAcquisitionError.outputInvalid }
        if let expectedSize, expectedSize != (width, height) {
            throw ScannerDuplexAcquisitionError.outputInvalid
        }
        expectedSize = (width, height)
        let pixels = Int64(width) * Int64(height)
        totalPixels += pixels
        guard totalPixels <= Int64(request.maxPixels) else {
            throw ScannerDuplexAcquisitionError.outputInvalid
        }
        let sequence = index + 1
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let metadata = ScannerDuplexPageResult(
            sequence: sequence,
            sheet: (sequence + 1) / 2,
            side: sequence.isMultiple(of: 2) ? "back" : "front",
            width: width,
            height: height,
            pixels: Int(pixels),
            digest: digest
        )
        pages.append(DecodedDuplexPage(image: image, metadata: metadata))
    }
    return pages
}

private func writeDuplexPDF(_ pages: [DecodedDuplexPage], destination: URL,
                            maximumBytes: Int, deadline: Date) throws -> Data {
    guard Date() < deadline, let first = pages.first else {
        throw ScannerDuplexAcquisitionError.deadlineExceeded
    }
    var box = CGRect(x: 0, y: 0, width: first.image.width, height: first.image.height)
    let pdfData = NSMutableData()
    guard let consumer = CGDataConsumer(data: pdfData),
          let context = CGContext(consumer: consumer, mediaBox: &box, nil) else {
        throw ScannerDuplexAcquisitionError.outputInvalid
    }
    for page in pages {
        guard Date() < deadline else { throw ScannerDuplexAcquisitionError.deadlineExceeded }
        context.beginPDFPage(nil)
        context.draw(page.image, in: box)
        context.endPDFPage()
    }
    context.closePDF()
    let data = pdfData as Data
    guard Date() < deadline, data.count > 5, data.count <= maximumBytes,
          data.starts(with: Data("%PDF-".utf8)) else {
        throw ScannerDuplexAcquisitionError.outputInvalid
    }
    let descriptor = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw ScannerDuplexAcquisitionError.outputInvalid }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    try handle.write(contentsOf: data)
    try handle.synchronize()
    return data
}

public func acquireScannerDuplex(_ request: ScannerDuplexRequest) throws -> ScannerDuplexResult {
    guard request.format == .pdf, request.source == .feeder, request.duplex,
          (2...50).contains(request.pageCount), request.pageCount.isMultiple(of: 2)
    else { throw ScannerProtocolError.scanUnsupported }
    let workspace = URL(fileURLWithPath: request.destination, isDirectory: true)
    guard validatePrivateDestination(workspace) else { throw ScannerProtocolError.invalidDestination }
    let outputURL = workspace.appendingPathComponent("duplex-scan.pdf", isDirectory: false)
    guard !FileManager.default.fileExists(atPath: outputURL.path) else {
        throw ScannerDuplexAcquisitionError.outputInvalid
    }
    let deadline = Date().addingTimeInterval(Double(request.deadlineMS) / 1_000)
    let scanner = try discoverDevice(id: request.deviceID, deadline: deadline)
    guard scannerOpaqueID(scanner) == request.deviceID else {
        throw ScannerDuplexAcquisitionError.unavailable
    }
    let delegate = DuplexAcquisitionDelegate()
    delegate.maximumPages = request.pageCount
    scanner.delegate = delegate
    scanner.requestOpenSession()
    guard runLoop(until: deadline, done: { delegate.opened }), delegate.openError == nil else {
        throw ScannerDuplexAcquisitionError.unavailable
    }
    defer { scanner.requestCloseSession() }
    try configureDuplex(scanner, request: request, delegate: delegate, deadline: deadline)
    scanner.downloadsDirectory = workspace
    scanner.requestScan()
    guard runLoop(until: deadline, done: { delegate.completed }) else {
        scanner.cancelScan()
        throw ScannerDuplexAcquisitionError.deadlineExceeded
    }
    guard delegate.scanError == nil, !delegate.overflow,
          delegate.scanURLs.count == request.pageCount else {
        throw ScannerDuplexAcquisitionError.scanFailed
    }
    let uniquePaths = Set(delegate.scanURLs.map(\.standardizedFileURL.path))
    guard uniquePaths.count == request.pageCount else {
        throw ScannerDuplexAcquisitionError.outputInvalid
    }
    let pages = try decodeDuplexPages(delegate.scanURLs, workspace: workspace,
                                      request: request, deadline: deadline)
    let pdfData = try writeDuplexPDF(pages, destination: outputURL,
                                     maximumBytes: request.maxBytes, deadline: deadline)
    for url in delegate.scanURLs { try? FileManager.default.removeItem(at: url) }
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outputURL.path)
    guard Date() < deadline else {
        try? FileManager.default.removeItem(at: outputURL)
        throw ScannerDuplexAcquisitionError.deadlineExceeded
    }
    let digest = SHA256.hash(data: pdfData).map { String(format: "%02x", $0) }.joined()
    return ScannerDuplexResult(
        pageCount: pages.count,
        bytes: pdfData.count,
        digest: digest,
        pages: pages.map(\.metadata)
    )
}

#else

public func acquireScannerDuplex(_ request: ScannerDuplexRequest) throws -> ScannerDuplexResult {
    throw ScannerProtocolError.scanUnsupported
}

#endif
