import Foundation
import PDFKit
import CoreGraphics

func dictionaryContainsObject(_ dictionary: CGPDFDictionaryRef, key: String) -> Bool {
    var object: CGPDFObjectRef?
    return CGPDFDictionaryGetObject(dictionary, key, &object)
}

func dictionaryContainsOnlyKeys(_ dictionary: CGPDFDictionaryRef, allowed: Set<String>) -> Bool {
    var valid = true
    CGPDFDictionaryApplyBlock(dictionary, { key, _, _ in
        if !allowed.contains(String(cString: key)) { valid = false }
        return valid
    }, nil)
    return valid
}

struct CropAnnotationDescriptor: Equatable {
    let publicSubtype: String
    let publicBounds: Rectangle
    let contentsDigest: String
    let publicFlags: Int
    let rawSubtype: String
    let rawBounds: Rectangle
    let rawFlags: Int
    let rawSensitiveShapeDigest: String
}

func annotationContentsDigest(_ contents: String?) -> String {
    var data = Data(contents == nil ? [0] : [1])
    if let contents { data.append(contents.data(using: .utf8) ?? Data()) }
    return sha256Hex(data)
}

private let maximumRawDescriptorDepth = 8
private let maximumRawDescriptorNodes = 2_048
private let maximumRawDescriptorOutputBytes = 128 * 1_024

final class RawDescriptorTraversalBudget {
    let rejectStreams: Bool
    private var visited: Set<UInt> = []
    private var nodeCount = 0
    private var outputBytes = 0

    init(rejectStreams: Bool = false) {
        self.rejectStreams = rejectStreams
    }

    func visit(_ object: CGPDFObjectRef) -> Bool {
        guard nodeCount < maximumRawDescriptorNodes else { return false }
        nodeCount += 1
        return visited.insert(UInt(bitPattern: unsafeBitCast(object, to: UnsafeRawPointer.self))).inserted
    }

    func record(_ value: String) -> String? {
        let bytes = value.utf8.count
        guard bytes <= maximumRawDescriptorOutputBytes - outputBytes else { return nil }
        outputBytes += bytes
        return value
    }
}

func rawPDFObjectShape(
    _ object: CGPDFObjectRef?, budget: RawDescriptorTraversalBudget, depth: Int = 0
) -> String? {
    guard let object else { return nil }
    guard depth < maximumRawDescriptorDepth else { return nil }
    switch CGPDFObjectGetType(object) {
    case .null:
        return budget.record("null")
    case .boolean:
        var value = false
        guard CGPDFObjectGetValue(object, .boolean, &value) else { return nil }
        return budget.record("boolean:\(value ? 1 : 0)")
    case .integer:
        var value: CGPDFInteger = 0
        guard CGPDFObjectGetValue(object, .integer, &value) else { return nil }
        return budget.record("integer:\(value)")
    case .real:
        var value: CGPDFReal = 0
        guard CGPDFObjectGetValue(object, .real, &value), value.isFinite else { return nil }
        return budget.record("real:\(value)")
    case .name:
        var value: UnsafePointer<CChar>?
        guard CGPDFObjectGetValue(object, .name, &value), let value else { return nil }
        let name = String(cString: value)
        guard name.utf8.count <= maximumStringLength else { return nil }
        return budget.record("name:\(name)")
    case .string:
        var value: CGPDFStringRef?
        guard CGPDFObjectGetValue(object, .string, &value), let value,
              CGPDFStringGetLength(value) <= maximumStringLength,
              let bytes = CGPDFStringGetBytePtr(value)
        else { return nil }
        return budget.record("string:\(sha256Hex(Data(bytes: bytes, count: CGPDFStringGetLength(value))))")
    case .array:
        var array: CGPDFArrayRef?
        guard CGPDFObjectGetValue(object, .array, &array), let array,
              CGPDFArrayGetCount(array) <= maximumAnnotationsPerPage,
              budget.visit(object)
        else { return nil }
        var values: [String] = []
        for index in 0..<CGPDFArrayGetCount(array) {
            var child: CGPDFObjectRef?
            guard CGPDFArrayGetObject(array, index, &child),
                  let shape = rawPDFObjectShape(child, budget: budget, depth: depth + 1) else {
                return nil
            }
            values.append(shape)
        }
        return budget.record("array:[\(values.joined(separator: ","))]")
    case .dictionary:
        var dictionary: CGPDFDictionaryRef?
        guard CGPDFObjectGetValue(object, .dictionary, &dictionary), let dictionary else { return nil }
        if pdfName(dictionary, key: "Type") == "Page" { return "page" }
        guard budget.visit(object) else { return nil }
        var values: [String] = []
        var valid = true
        CGPDFDictionaryApplyBlock(dictionary, { key, value, _ in
            let name = String(cString: key)
            guard valid, values.count < maximumAnnotationsPerPage,
                  name.utf8.count <= maximumStringLength,
                  let shape = rawPDFObjectShape(value, budget: budget, depth: depth + 1)
            else { valid = false; return false }
            values.append("\(name)=\(shape)")
            return true
        }, nil)
        guard valid else { return nil }
        return budget.record("dictionary:{\(values.sorted().joined(separator: ","))}")
    case .stream:
        // Core Graphics may decode an arbitrarily large compressed stream here. This preservation
        // profile rejects stream-bearing annotation descriptors instead of materializing one.
        guard !budget.rejectStreams else { return nil }
        return budget.record("stream")
    @unknown default:
        return nil
    }
}

func rawAnnotationBounds(_ annotation: CGPDFDictionaryRef) -> Rectangle? {
    var values: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(annotation, "Rect", &values), let values,
          CGPDFArrayGetCount(values) == 4
    else { return nil }
    var coordinates = Array(repeating: CGPDFReal(0), count: 4)
    for index in coordinates.indices {
        guard CGPDFArrayGetNumber(values, index, &coordinates[index]), coordinates[index].isFinite else { return nil }
    }
    return Rectangle(
        x: Double(coordinates[0]), y: Double(coordinates[1]),
        width: Double(coordinates[2] - coordinates[0]), height: Double(coordinates[3] - coordinates[1])
    )
}

func rawAnnotationSensitiveShapeDigest(
    _ annotation: CGPDFDictionaryRef, budget: RawDescriptorTraversalBudget
) -> String? {
    let keys = ["A", "AA", "PA", "URI", "Dest", "Popup", "Parent", "AP"]
    var values: [String] = []
    for key in keys {
        guard dictionaryContainsObject(annotation, key: key) else {
            values.append("\(key):absent")
            continue
        }
        var object: CGPDFObjectRef?
        guard CGPDFDictionaryGetObject(annotation, key, &object),
              let shape = rawPDFObjectShape(object, budget: budget)
        else { return nil }
        values.append("\(key):\(shape)")
    }
    return sha256Hex(Data(values.joined(separator: "\n").utf8))
}

func cropAnnotationDescriptors(
    _ document: PDFDocument, pageIndex: Int, budget: RawDescriptorTraversalBudget
) -> [CropAnnotationDescriptor]? {
    guard let page = document.page(at: pageIndex),
          page.annotations.count <= maximumAnnotationsPerPage,
          let documentRef = document.documentRef,
          let rawPage = documentRef.page(at: pageIndex + 1),
          let pageDictionary = rawPage.dictionary
    else { return nil }
    var rawAnnotations: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &rawAnnotations) else {
        return page.annotations.isEmpty ? [] : nil
    }
    guard let rawAnnotations,
          CGPDFArrayGetCount(rawAnnotations) == page.annotations.count,
          CGPDFArrayGetCount(rawAnnotations) <= maximumAnnotationsPerPage
    else { return nil }
    var descriptors: [CropAnnotationDescriptor] = []
    for index in 0..<page.annotations.count {
        let annotation = page.annotations[index]
        guard annotation.contents?.utf8.count ?? 0 <= maximumStringLength else { return nil }
        var rawAnnotation: CGPDFDictionaryRef?
        guard CGPDFArrayGetDictionary(rawAnnotations, index, &rawAnnotation), let rawAnnotation,
              let rawSubtype = pdfName(rawAnnotation, key: "Subtype"),
              let rawBounds = rawAnnotationBounds(rawAnnotation),
              let rawFlags = pdfIntegerOrZero(rawAnnotation, key: "F"),
              let rawSensitiveShapeDigest = rawAnnotationSensitiveShapeDigest(rawAnnotation, budget: budget)
        else { return nil }
        descriptors.append(CropAnnotationDescriptor(
            publicSubtype: annotationSubtype(annotation),
            publicBounds: rectangle(annotation.bounds),
            contentsDigest: annotationContentsDigest(annotation.contents),
            publicFlags: (annotation.value(forAnnotationKey: .flags) as? NSNumber)?.intValue ?? 0,
            rawSubtype: rawSubtype,
            rawBounds: rawBounds,
            rawFlags: rawFlags,
            rawSensitiveShapeDigest: rawSensitiveShapeDigest
        ))
    }
    return descriptors
}
