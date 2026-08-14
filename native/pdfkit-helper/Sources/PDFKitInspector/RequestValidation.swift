import Foundation
import PDFKit
import CryptoKit
import CoreGraphics

let annotationTypes = [
    "text", "link", "freeText", "line", "square", "circle", "highlight", "underline",
    "strikeOut", "ink", "stamp", "popup", "widget", "unknown",
]

func boundedString(_ value: String?) -> String? {
    guard let value else { return nil }
    if value.utf8.count <= maximumStringLength { return value }
    var bytes = Array(value.utf8.prefix(maximumStringLength))
    while !bytes.isEmpty {
        if let bounded = String(bytes: bytes, encoding: .utf8) { return bounded }
        bytes.removeLast()
    }
    return ""
}

func finite(_ value: CGFloat) -> Double {
    let number = Double(value)
    return number.isFinite ? number : 0
}

func rectangle(_ rect: CGRect) -> Rectangle {
    Rectangle(x: finite(rect.origin.x), y: finite(rect.origin.y), width: finite(rect.width), height: finite(rect.height))
}

func annotationSubtype(_ annotation: PDFAnnotation) -> String {
    let subtype = (annotation.type ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    switch subtype {
    case "Text": return "text"
    case "Link": return "link"
    case "FreeText": return "freeText"
    case "Line": return "line"
    case "Square": return "square"
    case "Circle": return "circle"
    case "Highlight": return "highlight"
    case "Underline": return "underline"
    case "StrikeOut": return "strikeOut"
    case "Ink": return "ink"
    case "Stamp": return "stamp"
    case "Popup": return "popup"
    case "Widget": return "widget"
    default: return "unknown"
    }
}

func widgetType(_ value: Any?) -> String {
    guard let rawType = value as? String else { return "unknown" }
    let type = rawType.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    switch type {
    case "Tx": return "text"
    case "Btn": return "button"
    case "Ch": return "choice"
    case "Sig": return "signature"
    default: return "unknown"
    }
}

func widgetControlKind(_ annotation: PDFAnnotation, fieldType: String) -> String? {
    guard fieldType == "button" else { return nil }
    switch annotation.widgetControlType {
    case .checkBoxControl: return "checkbox"
    case .radioButtonControl: return "radio"
    case .pushButtonControl: return "push"
    default: return "unknown"
    }
}

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func annotationFingerprint(
    sourceDigest: String,
    page: Int,
    annotationIndex: Int,
    subtype: String,
    widgetType: String?
) -> String {
    let normalizedWidgetType = widgetType ?? "none"
    let descriptor = [
        "pdfkit-inspector:opaque-locator:v1",
        "source-sha256=\(sourceDigest)",
        "page=\(page)",
        "annotation-index=\(annotationIndex)",
        "subtype=\(subtype)",
        "widget-type=\(normalizedWidgetType)",
    ].joined(separator: "\n")
    return sha256Hex(Data(descriptor.utf8))
}

func strictRequest(from data: Data) throws -> Request {
    guard data.count <= maxRequestBytes else { throw InspectionFailure.requestTooLarge }
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == Set(["version", "operation", "inputFilename", "limits"]),
          let limits = object["limits"] as? [String: Any],
          Set(limits.keys) == Set(["maxPages", "maxAnnotationsPerPage", "maxWidgetsPerPage", "maxOutlineDepth", "maxOutlineItems"])
    else { throw InspectionFailure.invalidRequest }

    let decoder = JSONDecoder()
    let request: Request
    do { request = try decoder.decode(Request.self, from: data) }
    catch { throw InspectionFailure.invalidRequest }

    guard request.version == protocolVersion,
          request.operation == "inspect",
          isSafeFilename(request.inputFilename),
          isWithin(request.limits.maxPages, 1, maximumPages),
          isWithin(request.limits.maxAnnotationsPerPage, 0, maximumAnnotationsPerPage),
          isWithin(request.limits.maxWidgetsPerPage, 0, maximumWidgetsPerPage),
          isWithin(request.limits.maxOutlineDepth, 0, maximumOutlineDepth),
          isWithin(request.limits.maxOutlineItems, 0, maximumOutlineItems)
    else { throw InspectionFailure.invalidRequest }
    return request
}
