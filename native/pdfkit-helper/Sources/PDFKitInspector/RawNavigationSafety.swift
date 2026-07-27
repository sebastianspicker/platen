import PDFKit
import CoreGraphics

struct RawLocalGoToDestination: Equatable {
    let page: Int
    let x: Double
    let y: Double
}

struct AllowedRawLocalGoTo {
    let page: Int
    let annotationIndex: Int
    let destination: RawLocalGoToDestination
}

let rawLocalGoToInertAnnotationSubtypes: Set<String> = [
    "Text", "Link", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine",
    "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Caret", "Ink", "Popup",
]

let rawLocalGoToProhibitedAnnotationPayloadKeys: Set<String> = [
    "AF", "FS", "EF", "Ref", "Sound", "Movie", "RichMediaContent", "RichMediaSettings",
    "3DD", "3DA", "3DV", "3DI", "ExData",
]

func rawLocalGoToAnnotationContainsProhibitedPayload(
    _ annotation: CGPDFDictionaryRef
) -> Bool {
    rawLocalGoToProhibitedAnnotationPayloadKeys.contains(where: {
        dictionaryContainsObject(annotation, key: $0)
    })
}

func rawExistingLocalGoToAnnotationIsSafe(_ annotation: CGPDFDictionaryRef) -> Bool {
    guard let subtype = pdfName(annotation, key: "Subtype"),
          rawLocalGoToInertAnnotationSubtypes.contains(subtype),
          !rawLocalGoToAnnotationContainsProhibitedPayload(annotation)
    else { return false }
    return !["A", "AA", "PA", "URI"].contains(where: {
        dictionaryContainsObject(annotation, key: $0)
    })
}

func rawAnnotationRelationshipGraphIsSafe(
    _ annotations: CGPDFArrayRef,
    document: CGPDFDocument,
    page: Int,
    allowing allowed: AllowedRawLocalGoTo?
) -> Bool {
    let count = CGPDFArrayGetCount(annotations)
    guard count <= maximumAnnotationsPerPage else { return false }
    var direct: [CGPDFDictionaryRef] = []
    var directIdentities: Set<UInt> = []
    for index in 0..<count {
        var annotation: CGPDFDictionaryRef?
        guard CGPDFArrayGetDictionary(annotations, index, &annotation), let annotation,
              directIdentities.insert(UInt(bitPattern: unsafeBitCast(annotation, to: UnsafeRawPointer.self))).inserted
        else { return false }
        if let allowed, allowed.page == page, allowed.annotationIndex == index {
            guard rawLocalGoToAnnotationMatches(annotation, document: document, expected: allowed.destination) else {
                return false
            }
        } else if !rawExistingLocalGoToAnnotationIsSafe(annotation) {
            return false
        }
        direct.append(annotation)
    }

    func identity(_ value: CGPDFDictionaryRef) -> UInt {
        UInt(bitPattern: unsafeBitCast(value, to: UnsafeRawPointer.self))
    }
    func related(_ annotation: CGPDFDictionaryRef, key: String) -> CGPDFDictionaryRef? {
        var value: CGPDFDictionaryRef?
        return CGPDFDictionaryGetDictionary(annotation, key, &value) ? value : nil
    }
    for annotation in direct {
        let subtype = pdfName(annotation, key: "Subtype")
        let hasParent = dictionaryContainsObject(annotation, key: "Parent")
        let hasPopup = dictionaryContainsObject(annotation, key: "Popup")
        if subtype == "Popup" {
            guard hasParent, !hasPopup, let parent = related(annotation, key: "Parent"),
                  directIdentities.contains(identity(parent)), pdfName(parent, key: "Subtype") != "Popup",
                  let reciprocalPopup = related(parent, key: "Popup"), identity(reciprocalPopup) == identity(annotation),
                  !["A", "AA", "PA", "URI"].contains(where: { dictionaryContainsObject(parent, key: $0) }),
                  !rawLocalGoToAnnotationContainsProhibitedPayload(parent)
            else { return false }
        } else {
            guard !hasParent else { return false }
            if hasPopup {
                guard let popup = related(annotation, key: "Popup"),
                      directIdentities.contains(identity(popup)), pdfName(popup, key: "Subtype") == "Popup",
                      let reciprocalParent = related(popup, key: "Parent"), identity(reciprocalParent) == identity(annotation),
                      !["A", "AA", "PA", "URI"].contains(where: { dictionaryContainsObject(popup, key: $0) }),
                      !rawLocalGoToAnnotationContainsProhibitedPayload(popup)
                else { return false }
            }
        }
    }
    return true
}

func rawLocalGoToDestination(
    _ array: CGPDFArrayRef,
    document: CGPDFDocument
) -> RawLocalGoToDestination? {
    guard CGPDFArrayGetCount(array) == 5 else { return nil }
    var pageDictionary: CGPDFDictionaryRef?
    var mode: UnsafePointer<CChar>?
    var x: CGPDFReal = 0
    var y: CGPDFReal = 0
    var zoom: CGPDFObjectRef?
    guard CGPDFArrayGetDictionary(array, 0, &pageDictionary), let pageDictionary,
          CGPDFArrayGetName(array, 1, &mode), let mode, String(cString: mode) == "XYZ",
          CGPDFArrayGetNumber(array, 2, &x), CGPDFArrayGetNumber(array, 3, &y),
          CGPDFArrayGetObject(array, 4, &zoom), let zoom, CGPDFObjectGetType(zoom) == .null
    else { return nil }
    var targetPage = 0
    for page in 1...document.numberOfPages {
        if document.page(at: page)?.dictionary == pageDictionary { targetPage = page; break }
    }
    guard targetPage > 0, x.isFinite, y.isFinite else { return nil }
    return RawLocalGoToDestination(page: targetPage, x: Double(x), y: Double(y))
}

func rawLocalGoToAnnotationMatches(
    _ annotation: CGPDFDictionaryRef,
    document: CGPDFDocument,
    expected: RawLocalGoToDestination
) -> Bool {
    guard pdfName(annotation, key: "Subtype") == "Link",
          !dictionaryContainsObject(annotation, key: "AA"),
          !dictionaryContainsObject(annotation, key: "PA"),
          !dictionaryContainsObject(annotation, key: "URI"),
          !rawLocalGoToAnnotationContainsProhibitedPayload(annotation)
    else { return false }
    var destination: CGPDFArrayRef?
    var action: CGPDFDictionaryRef?
    var actionDestination: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(annotation, "Dest", &destination), let destination,
          rawLocalGoToDestination(destination, document: document) == expected,
          CGPDFDictionaryGetDictionary(annotation, "A", &action), let action,
          dictionaryContainsOnlyKeys(action, allowed: ["S", "D"]),
          pdfName(action, key: "S") == "GoTo",
          CGPDFDictionaryGetArray(action, "D", &actionDestination), let actionDestination,
          rawLocalGoToDestination(actionDestination, document: document) == expected
    else { return false }
    return true
}

func rawLocalGoToOutlineIsSafe(_ catalog: CGPDFDictionaryRef, limits: Limits) -> Bool {
    guard dictionaryContainsObject(catalog, key: "Outlines") else { return true }
    guard limits.maxOutlineDepth > 0, limits.maxOutlineItems > 0 else { return false }
    var root: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(catalog, "Outlines", &root), let root,
          !dictionaryContainsObject(root, key: "A"), !dictionaryContainsObject(root, key: "AA")
    else { return false }
    guard dictionaryContainsObject(root, key: "First") else { return true }
    var first: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(root, "First", &first), let first else { return false }
    var remaining = limits.maxOutlineItems
    func visit(_ initial: CGPDFDictionaryRef, depth: Int) -> Bool {
        guard depth <= limits.maxOutlineDepth else { return false }
        var current: CGPDFDictionaryRef? = initial
        while let item = current {
            guard remaining > 0,
                  !dictionaryContainsObject(item, key: "A"), !dictionaryContainsObject(item, key: "AA")
            else { return false }
            remaining -= 1
            if dictionaryContainsObject(item, key: "First") {
                var child: CGPDFDictionaryRef?
                guard CGPDFDictionaryGetDictionary(item, "First", &child), let child,
                      visit(child, depth: depth + 1) else { return false }
            }
            guard dictionaryContainsObject(item, key: "Next") else { current = nil; continue }
            var next: CGPDFDictionaryRef?
            guard CGPDFDictionaryGetDictionary(item, "Next", &next), let next else { return false }
            current = next
        }
        return true
    }
    return visit(first, depth: 1)
}

func rawLocalGoToGraphIsSafe(
    _ document: PDFDocument,
    limits: Limits,
    allowing allowed: AllowedRawLocalGoTo? = nil
) -> Bool {
    guard document.pageCount >= 1, document.pageCount <= limits.maxPages,
          let documentRef = document.documentRef, let catalog = documentRef.catalog,
          !["OpenAction", "AA", "AF", "Perms", "AcroForm"].contains(where: {
              dictionaryContainsObject(catalog, key: $0)
          }), rawLocalGoToOutlineIsSafe(catalog, limits: limits)
    else { return false }
    if dictionaryContainsObject(catalog, key: "Names") {
        var names: CGPDFDictionaryRef?
        guard CGPDFDictionaryGetDictionary(catalog, "Names", &names), let names,
              dictionaryContainsOnlyKeys(names, allowed: ["Dests"])
        else { return false }
    }
    for pageNumber in 1...document.pageCount {
        guard let page = document.page(at: pageNumber - 1),
              let pageDictionary = documentRef.page(at: pageNumber)?.dictionary,
              !["AA", "AF", "PresSteps", "Dur", "Trans"].contains(where: {
                  dictionaryContainsObject(pageDictionary, key: $0)
              })
        else { return false }
        var annotations: CGPDFArrayRef?
        let hasRawAnnotations = CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations)
        if !hasRawAnnotations {
            guard page.annotations.isEmpty else { return false }
            continue
        }
        guard let annotations,
              CGPDFArrayGetCount(annotations) <= limits.maxAnnotationsPerPage,
              CGPDFArrayGetCount(annotations) <= maximumAnnotationsPerPage,
              page.annotations.count <= limits.maxAnnotationsPerPage,
              page.annotations.count <= maximumAnnotationsPerPage
        else { return false }
        guard rawAnnotationRelationshipGraphIsSafe(
            annotations, document: documentRef, page: pageNumber, allowing: allowed
        ) else { return false }
    }
    return true
}
