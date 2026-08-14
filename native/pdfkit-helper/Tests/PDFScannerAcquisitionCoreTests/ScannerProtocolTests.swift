import Foundation
import XCTest
@testable import PDFScannerAcquisitionCore

final class ScannerProtocolTests: XCTestCase {
    func testListRequestIsExactAndBounded() throws {
        XCTAssertEqual(try parseScannerRequest(Data(#"{"version":1,"operation":"list"}"#.utf8)), .list(ScannerListRequest()))
        XCTAssertThrowsError(try parseScannerRequest(Data(#"{"version":1,"operation":"list","extra":true}"#.utf8)))
        XCTAssertThrowsError(try parseScannerRequest(Data(repeating: 0x20, count: 16_385)))
    }

    func testScanRequestValidatesOpaqueIDBoundsAndFormats() throws {
        let data = Data(#"{"version":1,"operation":"scan","deviceId":"scanner-1","destination":"/tmp/scanner-workspace","page":1,"maxBytes":1048576,"deadlineMs":5000,"format":"PDF","source":"flatbed","duplex":false,"color":"gray","dpi":300,"pageCount":1}"#.utf8)
        guard case .scan(let request) = try parseScannerRequest(data) else { return XCTFail("expected scan") }
        XCTAssertEqual(request.deviceID, "scanner-1")
        XCTAssertEqual(request.format, .pdf)
        XCTAssertEqual(request.source, .flatbed)
        XCTAssertEqual(request.dpi, 300)
        let badID = Data(#"{"version":1,"operation":"scan","deviceId":"serial/secret","destination":"/tmp/scanner-workspace","page":1,"maxBytes":1048576,"deadlineMs":5000,"format":"PDF","source":"flatbed","duplex":false,"color":"gray","dpi":300,"pageCount":1}"#.utf8)
        XCTAssertThrowsError(try parseScannerRequest(badID))
        let badPage = Data(#"{"version":1,"operation":"scan","deviceId":"scanner-1","destination":"/tmp/scanner-workspace","page":0,"maxBytes":1048576,"deadlineMs":5000,"format":"PDF","source":"flatbed","duplex":false,"color":"gray","dpi":300,"pageCount":1}"#.utf8)
        XCTAssertThrowsError(try parseScannerRequest(badPage))
    }

    func testDuplexRequestIsDistinctExactAndEvenPageBounded() throws {
        let valid = Data(#"{"version":1,"operation":"scanDuplex","deviceId":"scanner-1","destination":"/tmp/scanner-workspace","maxBytes":1048576,"maxPixels":200000000,"deadlineMs":5000,"format":"PDF","source":"feeder","duplex":true,"color":"gray","dpi":300,"pageCount":4}"#.utf8)
        guard case .scanDuplex(let request) = try parseScannerRequest(valid) else {
            return XCTFail("expected duplex scan")
        }
        XCTAssertEqual(request.source, .feeder)
        XCTAssertTrue(request.duplex)
        XCTAssertEqual(request.pageCount, 4)
        let odd = Data(#"{"version":1,"operation":"scanDuplex","deviceId":"scanner-1","destination":"/tmp/scanner-workspace","maxBytes":1048576,"maxPixels":200000000,"deadlineMs":5000,"format":"PDF","source":"feeder","duplex":true,"color":"gray","dpi":300,"pageCount":3}"#.utf8)
        XCTAssertThrowsError(try parseScannerRequest(odd))
        let flatbedConfusion = Data(#"{"version":1,"operation":"scan","deviceId":"scanner-1","destination":"/tmp/scanner-workspace","page":1,"maxBytes":1048576,"deadlineMs":5000,"format":"PDF","source":"feeder","duplex":false,"color":"gray","dpi":300,"pageCount":1}"#.utf8)
        XCTAssertThrowsError(try parseScannerRequest(flatbedConfusion))
    }

    func testDestinationMustBeExistingPrivateNonSymlinkDirectory() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        XCTAssertTrue(validatePrivateDestination(root))
        let publicDirectory = root.appendingPathComponent("public")
        try FileManager.default.createDirectory(at: publicDirectory, withIntermediateDirectories: false)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: publicDirectory.path)
        XCTAssertFalse(validatePrivateDestination(publicDirectory))
        XCTAssertFalse(validDestinationString(root.appendingPathComponent("../escape").path))
        try FileManager.default.removeItem(at: root)
    }

    func testScannerImageInputMustBePrivateDirectBoundedSingleLinkChild() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        let input = root.appendingPathComponent("scan.jpg")
        try Data(repeating: 0x01, count: 16).write(to: input, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: input.path)
        XCTAssertTrue(validateScannerImageInput(input, workspace: root, maximumBytes: 32))
        let outside = root.deletingLastPathComponent().appendingPathComponent("outside.jpg")
        try Data(repeating: 0x01, count: 16).write(to: outside, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outside.path)
        XCTAssertFalse(validateScannerImageInput(outside, workspace: root, maximumBytes: 32))
        let link = root.appendingPathComponent("link.jpg")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: input)
        XCTAssertFalse(validateScannerImageInput(link, workspace: root, maximumBytes: 32))
        let hardlink = root.appendingPathComponent("hardlink.jpg")
        try FileManager.default.linkItem(at: input, to: hardlink)
        XCTAssertFalse(validateScannerImageInput(hardlink, workspace: root, maximumBytes: 32))
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: input.path)
        XCTAssertFalse(validateScannerImageInput(input, workspace: root, maximumBytes: 32))
        try FileManager.default.removeItem(at: root)
        try FileManager.default.removeItem(at: outside)
    }

    func testUnsupportedScanIsExplicitAndDoesNotClaimLiveVerification() {
        let envelope = unsupportedScanEnvelope()
        XCTAssertFalse(envelope.ok)
        XCTAssertEqual(envelope.error?.code, "SCANNER_SCAN_UNSUPPORTED")
        XCTAssertEqual(envelope.error?.evidence.liveVerification, false)
        let duplex = unsupportedDuplexEnvelope()
        XCTAssertFalse(duplex.ok)
        XCTAssertEqual(duplex.error?.code, "SCANNER_DUPLEX_UNSUPPORTED")
        XCTAssertEqual(duplex.error?.evidence.liveVerification, false)
    }

    func testFramerBoundsBeforeAccumulatingAndDrainsOversizedFrames() {
        var framer = ScannerLineFramer(maximumFrameBytes: 4)
        XCTAssertEqual(framer.append(Data("abc".utf8)), [])
        XCTAssertEqual(framer.append(Data("d\r\nnext\n".utf8)), [.oversized, .line(Data("next".utf8))])
        XCTAssertEqual(framer.append(Data("tail".utf8)), [])
        XCTAssertEqual(framer.finish(), [.line(Data("tail".utf8))])
    }

    func testFramerHandlesNonUTF8AndNulAsDeterministicInvalidPayloads() throws {
        var framer = ScannerLineFramer()
        let frames = framer.append(Data([0x7b, 0x22, 0x76, 0x22, 0x3a, 0xff, 0x7d, 0x0a]))
        guard case .line(let data) = frames.first else { return XCTFail("expected line") }
        XCTAssertThrowsError(try parseScannerRequest(data))
        var nulFramer = ScannerLineFramer()
        let nul = nulFramer.append(Data([0x7b, 0x00, 0x7d, 0x0a]))
        guard case .line(let nulData) = nul.first else { return XCTFail("expected line") }
        XCTAssertThrowsError(try parseScannerRequest(nulData))
    }

    func testDuplicateKeysAndTypeConfusionAreRejected() {
        let duplicate = Data(#"{"version":1,"operation":"list","operation":"scan"}"#.utf8)
        XCTAssertThrowsError(try parseScannerRequest(duplicate))
        let booleanPage = Data(#"{"version":1,"operation":"scan","deviceId":"scanner-1","destination":"/tmp/scanner-workspace","page":true,"maxBytes":1048576,"deadlineMs":5000,"format":"PDF","source":"flatbed","duplex":false,"color":"gray","dpi":300,"pageCount":1}"#.utf8)
        XCTAssertThrowsError(try parseScannerRequest(booleanPage))
        let fractionalPage = Data(#"{"version":1,"operation":"scan","deviceId":"scanner-1","destination":"/tmp/scanner-workspace","page":1.5,"maxBytes":1048576,"deadlineMs":5000,"format":"PDF","source":"flatbed","duplex":false,"color":"gray","dpi":300,"pageCount":1}"#.utf8)
        XCTAssertThrowsError(try parseScannerRequest(fractionalPage))
        let exponentPage = Data(#"{"version":1,"operation":"scan","deviceId":"scanner-1","destination":"/tmp/scanner-workspace","page":1e0,"maxBytes":1048576,"deadlineMs":5000,"format":"PDF","source":"flatbed","duplex":false,"color":"gray","dpi":300,"pageCount":1}"#.utf8)
        XCTAssertThrowsError(try parseScannerRequest(exponentPage))
        let hugeBytes = Data(#"{"version":1,"operation":"scan","deviceId":"scanner-1","destination":"/tmp/scanner-workspace","page":1,"maxBytes":999999999999999999999999999,"deadlineMs":5000,"format":"PDF","source":"flatbed","duplex":false,"color":"gray","dpi":300,"pageCount":1}"#.utf8)
        XCTAssertThrowsError(try parseScannerRequest(hugeBytes))
    }

    func testScannerMetadataIsSanitizedAndBounded() {
        let name = sanitizedScannerName("  Scanner\u{0000}\u{E000}\u{0378}\n  ")
        XCTAssertFalse(name.contains("\u{0000}"))
        XCTAssertFalse(name.contains("\u{E000}"))
        XCTAssertLessThanOrEqual(name.unicodeScalars.count, 80)
        XCTAssertLessThanOrEqual(name.utf8.count, 256)
    }
}
