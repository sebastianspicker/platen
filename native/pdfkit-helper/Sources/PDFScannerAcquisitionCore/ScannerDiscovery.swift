import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

#if canImport(ImageCaptureCore)
import ImageCaptureCore

private final class BrowserDelegate: NSObject, ICDeviceBrowserDelegate {
    var devices: [ICDevice] = []
    var enumerated = false

    func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        if device.type == .scanner { devices.append(device) }
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        devices.removeAll { $0 === device }
    }

    func deviceBrowserDidEnumerateLocalDevices(_ browser: ICDeviceBrowser) {
        enumerated = true
    }
}

public func discoverScanners(timeoutMS: Int = 500) -> ScannerListResult {
    let delegate = BrowserDelegate()
    let browser = ICDeviceBrowser()
    browser.delegate = delegate
    browser.browsedDeviceTypeMask = .scanner
    browser.start()
    let boundedTimeout = min(max(timeoutMS, 1), 500)
    let deadline = Date().addingTimeInterval(Double(boundedTimeout) / 1_000)
    while !delegate.enumerated && Date() < deadline {
        _ = RunLoop.current.run(mode: .default, before: min(deadline, Date().addingTimeInterval(0.05)))
    }
    browser.stop()
    let devices = delegate.devices.compactMap { device -> ScannerDevice? in
        guard let persistent = device.persistentIDString, !persistent.isEmpty else { return nil }
        let digest = persistent.data(using: .utf8).map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() } ?? ""
        guard !digest.isEmpty else { return nil }
        return ScannerDevice(id: "scanner-" + String(digest.prefix(32)), name: sanitizedScannerName(device.name))
    }.sorted { $0.id < $1.id }.prefix(64)
    return ScannerListResult(devices: Array(devices), evidence: ScannerEvidence(discoveryAttempted: true))
}

#else

public func discoverScanners(timeoutMS: Int = 500) -> ScannerListResult {
    ScannerListResult(devices: [], evidence: ScannerEvidence(api: "ImageCaptureCore", discoveryAttempted: false, liveVerification: false, scanSupport: "unavailable-on-platform"))
}

#endif
