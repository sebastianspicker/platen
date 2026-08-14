import Foundation
import PDFKit
import AppKit
import CoreGraphics

private let radioButtonFlag = 1 << 15
private let pushButtonFlag = 1 << 16
private let radiosInUnisonFlag = 1 << 25
private let readOnlyRadioFieldFlag = 1 << 0
private let requiredRadioFieldFlag = 1 << 1
private let noExportRadioFieldFlag = 1 << 2
private let noToggleToOffRadioFieldFlag = 1 << 14

private struct RadioChild {
    let page: Int
    let annotationIndex: Int
    let onState: String
}

private struct RadioGroup {
    let flags: Int
    let children: [RadioChild]
    let selectedChildIndex: Int?
    let targetChildIndex: Int
}

struct RadioMutationSnapshot {
    let topologyDigest: String
    let targetPage: Int
    let renderSHA256: [Int: String]
    let members: [(page: Int, annotationIndex: Int, onState: String)]
    let flags: Int
}

private func validRadioAppearanceName(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    return isWithin(bytes.count, 1, 127)
        && bytes.allSatisfy { byte in byte >= 0x21 && byte <= 0x7e && ![35, 37, 40, 41, 47, 60, 62, 91, 93, 123, 125].contains(byte) }
}

private func radioNormalAppearanceState(_ widget: CGPDFDictionaryRef) -> String? {
    var appearance: CGPDFDictionaryRef?
    var normal: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(widget, "AP", &appearance), let appearance,
          dictionaryContainsOnlyKeys(appearance, allowed: ["N"]),
          CGPDFDictionaryGetDictionary(appearance, "N", &normal), let normal
    else { return nil }
    var names: [String] = []
    var valid = true
    CGPDFDictionaryApplyBlock(normal, { key, value, _ in
        valid = valid && CGPDFObjectGetType(value) == .stream
        names.append(String(cString: key))
        return valid && names.count <= 2
    }, nil)
    guard valid, names.count == 2, names.contains("Off"),
          let onState = names.first(where: { $0 != "Off" }), validRadioAppearanceName(onState)
    else { return nil }
    return onState
}

private func rawRadioAnnotationLocation(_ document: PDFDocument, object: CGPDFObjectRef) -> (Int, Int, CGPDFDictionaryRef)? {
    guard let documentRef = document.documentRef else { return nil }
    var found: (Int, Int, CGPDFDictionaryRef)?
    for page in 1...document.pageCount {
        guard let pageDictionary = documentRef.page(at: page)?.dictionary else { return nil }
        var annotations: CGPDFArrayRef?
        guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations), let annotations else { continue }
        for index in 0..<CGPDFArrayGetCount(annotations) {
            var candidate: CGPDFObjectRef?
            guard CGPDFArrayGetObject(annotations, index, &candidate), let candidate else { return nil }
            guard candidate == object else { continue }
            guard found == nil else { return nil }
            found = (page, index, pageDictionary)
        }
    }
    return found
}

private func normalizedRadioAnnotationLocation(_ document: PDFDocument, rootObject: CGPDFObjectRef, onState: String) -> (Int, Int, CGPDFDictionaryRef)? {
    guard let documentRef = document.documentRef else { return nil }
    var found: (Int, Int, CGPDFDictionaryRef)?
    for page in 1...document.pageCount {
        guard let pageDictionary = documentRef.page(at: page)?.dictionary else { return nil }
        var annotations: CGPDFArrayRef?
        guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations), let annotations else { continue }
        for index in 0..<CGPDFArrayGetCount(annotations) {
            var widget: CGPDFDictionaryRef?
            var parent: CGPDFObjectRef?
            guard CGPDFArrayGetDictionary(annotations, index, &widget), let widget,
                  CGPDFDictionaryGetObject(widget, "Parent", &parent), parent == rootObject,
                  radioNormalAppearanceState(widget) == onState
            else { continue }
            guard found == nil else { return nil }
            found = (page, index, pageDictionary)
        }
    }
    return found
}

private func canonicalRadioGroup(document: PDFDocument, page: Int, annotationIndex: Int, annotation: PDFAnnotation, normalized: Bool = false) -> RadioGroup? {
    guard widgetControlKind(annotation, fieldType: "button") == "radio",
          let documentRef = document.documentRef, let targetPage = documentRef.page(at: page)?.dictionary
    else { return nil }
    var targetAnnotations: CGPDFArrayRef?; var targetObject: CGPDFObjectRef?; var targetWidget: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetArray(targetPage, "Annots", &targetAnnotations), let targetAnnotations,
          annotationIndex < CGPDFArrayGetCount(targetAnnotations),
          CGPDFArrayGetObject(targetAnnotations, annotationIndex, &targetObject), let targetObject,
          CGPDFArrayGetDictionary(targetAnnotations, annotationIndex, &targetWidget), let targetWidget,
          pdfName(targetWidget, key: "Subtype") == "Widget"
    else { return nil }
    var rootObject: CGPDFObjectRef?; var root: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetObject(targetWidget, "Parent", &rootObject), let rootObject,
          CGPDFDictionaryGetDictionary(targetWidget, "Parent", &root), let root,
          !dictionaryContainsObject(root, key: "Parent"), pdfName(root, key: "FT") == "Btn",
          let fieldName = pdfTextString(root, key: "T"), isWithin(fieldName.utf8.count, 1, 1024),
          !["A", "AA", "DV", "Opt"].contains(where: { dictionaryContainsObject(root, key: $0) })
    else { return nil }
    var rawFlags: CGPDFInteger = 0
    let containsRootFlags = dictionaryContainsObject(root, key: "Ff")
    let hasRootFlags = CGPDFDictionaryGetInteger(root, "Ff", &rawFlags)
    guard (!containsRootFlags || hasRootFlags), hasRootFlags || normalized else { return nil }
    var effectiveFlags = hasRootFlags ? Int(rawFlags) : nil
    var acroForm: CGPDFDictionaryRef?; var fields: CGPDFArrayRef?
    guard let catalog = documentRef.catalog, CGPDFDictionaryGetDictionary(catalog, "AcroForm", &acroForm), let acroForm,
          CGPDFDictionaryGetArray(acroForm, "Fields", &fields), let fields,
          isWithin(CGPDFArrayGetCount(fields), 1, maximumPages * maximumAnnotationsPerPage)
    else { return nil }
    var rootOccurrences = 0
    for index in 0..<CGPDFArrayGetCount(fields) { var field: CGPDFObjectRef?; guard CGPDFArrayGetObject(fields, index, &field), let field else { return nil }; if field == rootObject { rootOccurrences += 1 } }
    guard rootOccurrences == 1 else { return nil }
    var kids: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(root, "Kids", &kids), let kids, isWithin(CGPDFArrayGetCount(kids), 2, 50) else { return nil }
    var children: [RadioChild] = []; var childObjects: [CGPDFObjectRef] = []; var states = Set<String>(); var selected: Int?; var target: Int?
    var childFlagsCount = 0; var childPageCount = 0; var directLocationCount = 0
    for index in 0..<CGPDFArrayGetCount(kids) {
        var childObject: CGPDFObjectRef?; var child: CGPDFDictionaryRef?
        guard CGPDFArrayGetObject(kids, index, &childObject), let childObject,
              !childObjects.contains(where: { $0 == childObject }), CGPDFArrayGetDictionary(kids, index, &child), let child,
              pdfName(child, key: "Subtype") == "Widget",
              !["Kids", "FT", "T", "V", "A", "AA", "DV", "Opt"].contains(where: { dictionaryContainsObject(child, key: $0) }),
              (normalized || !dictionaryContainsObject(child, key: "Ff"))
        else { return nil }
        var childFlags: CGPDFInteger = 0
        let containsChildFlags = dictionaryContainsObject(child, key: "Ff")
        let hasChildFlags = CGPDFDictionaryGetInteger(child, "Ff", &childFlags)
        guard !containsChildFlags || hasChildFlags else { return nil }
        if hasChildFlags { childFlagsCount += 1 }
        if normalized { guard hasRootFlags || hasChildFlags else { return nil }; let candidate = hasChildFlags ? Int(childFlags) : effectiveFlags; guard let candidate, effectiveFlags == nil || effectiveFlags == candidate else { return nil }; effectiveFlags = candidate }
        var parent: CGPDFObjectRef?; var childPage: CGPDFDictionaryRef?; let hasChildPage = CGPDFDictionaryGetDictionary(child, "P", &childPage)
        if hasChildPage { childPageCount += 1 }
        let directLocation = rawRadioAnnotationLocation(document, object: childObject)
        if directLocation != nil { directLocationCount += 1 }
        guard CGPDFDictionaryGetObject(child, "Parent", &parent), parent == rootObject,
              let onState = radioNormalAppearanceState(child),
              let location = directLocation ?? (normalized ? normalizedRadioAnnotationLocation(document, rootObject: rootObject, onState: onState) : nil),
              childPage.map({ location.2 == $0 }) == true || (normalized && !hasChildPage),
              let appearance = pdfName(child, key: "AS"), ["Off", onState].contains(appearance), states.insert(onState).inserted
        else { return nil }
        if appearance != "Off" { guard selected == nil else { return nil }; selected = index }
        if childObject == targetObject || (normalized && location.0 == page && location.1 == annotationIndex && radioNormalAppearanceState(targetWidget) == onState) { guard target == nil else { return nil }; target = index }
        childObjects.append(childObject); children.append(RadioChild(page: location.0, annotationIndex: location.1, onState: onState))
    }
    let childCount = CGPDFArrayGetCount(kids)
    if normalized {
        guard (hasRootFlags && childFlagsCount == 0) || (!hasRootFlags && childFlagsCount == childCount),
              childPageCount == 0 || childPageCount == childCount,
              directLocationCount == 0 || directLocationCount == childCount
        else { return nil }
    }
    let allowedFlags = radioButtonFlag | requiredRadioFieldFlag | noExportRadioFieldFlag | noToggleToOffRadioFieldFlag
    guard let target, let flags = effectiveFlags, flags & radioButtonFlag != 0,
          flags & (pushButtonFlag | radiosInUnisonFlag | readOnlyRadioFieldFlag) == 0,
          flags & ~allowedFlags == 0 else { return nil }
    if dictionaryContainsObject(root, key: "V") {
        guard let value = pdfName(root, key: "V"), selected.map({ value == children[$0].onState }) ?? (value == "Off") else { return nil }
    } else if selected != nil { return nil }
    return RadioGroup(flags: flags, children: children, selectedChildIndex: selected, targetChildIndex: target)
}

private func radioTopologyDigest(_ group: RadioGroup) -> String {
    let topology = group.children.map { "\(group.flags)|\($0.page)|\($0.annotationIndex)|\($0.onState)" }.sorted().joined(separator: "\n")
    return sha256Hex(Data(topology.utf8))
}

func radioSelectionCanApply(document: PDFDocument, page: Int, annotationIndex: Int, annotation: PDFAnnotation) -> Bool {
    guard let group = canonicalRadioGroup(document: document, page: page, annotationIndex: annotationIndex, annotation: annotation) else { return false }
    return group.selectedChildIndex != group.targetChildIndex
}

func radioSelectionSnapshot(document: PDFDocument, page: Int, annotationIndex: Int, annotation: PDFAnnotation) -> RadioMutationSnapshot? {
    guard let group = canonicalRadioGroup(document: document, page: page, annotationIndex: annotationIndex, annotation: annotation) else { return nil }
    var pages = Set([group.children[group.targetChildIndex].page])
    if let selected = group.selectedChildIndex { pages.insert(group.children[selected].page) }
    var hashes: [Int: String] = [:]
    for affectedPage in pages { guard let hash = targetedRenderSHA256(document, page: affectedPage) else { return nil }; hashes[affectedPage] = hash }
    return RadioMutationSnapshot(
        topologyDigest: radioTopologyDigest(group), targetPage: group.children[group.targetChildIndex].page,
        renderSHA256: hashes, members: group.children.map { ($0.page, $0.annotationIndex, $0.onState) }, flags: group.flags
    )
}

func verifiesRadioSelection(document: PDFDocument, page: Int, annotationIndex: Int, annotation: PDFAnnotation, snapshot: RadioMutationSnapshot) -> Bool {
    guard let group = canonicalRadioGroup(
        document: document, page: page, annotationIndex: annotationIndex,
        annotation: annotation, normalized: true
    ), group.selectedChildIndex == group.targetChildIndex,
       group.children[group.targetChildIndex].page == snapshot.targetPage,
       group.flags == snapshot.flags,
       radioTopologyDigest(group) == snapshot.topologyDigest
    else { return false }
    guard let documentRef = document.documentRef, let targetPage = documentRef.page(at: page)?.dictionary else { return false }
    var targetAnnotations: CGPDFArrayRef?; var target: CGPDFDictionaryRef?; var rootObject: CGPDFObjectRef?; var root: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetArray(targetPage, "Annots", &targetAnnotations), let targetAnnotations,
          annotationIndex < CGPDFArrayGetCount(targetAnnotations), CGPDFArrayGetDictionary(targetAnnotations, annotationIndex, &target), let target,
          let targetOnState = radioNormalAppearanceState(target), CGPDFDictionaryGetObject(target, "Parent", &rootObject), let rootObject,
          CGPDFDictionaryGetDictionary(target, "Parent", &root), let root, pdfName(root, key: "V") == targetOnState
    else { return false }
    var rootKids: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(root, "Kids", &rootKids), let rootKids,
          CGPDFArrayGetCount(rootKids) == snapshot.members.count
    else { return false }
    let expectedStates = Set(snapshot.members.map(\.onState))
    var rootStates = Set<String>()
    for index in 0..<CGPDFArrayGetCount(rootKids) {
        var child: CGPDFDictionaryRef?; var parent: CGPDFObjectRef?
        guard CGPDFArrayGetDictionary(rootKids, index, &child), let child,
              CGPDFDictionaryGetObject(child, "Parent", &parent), parent == rootObject,
              let onState = radioNormalAppearanceState(child),
              let appearance = pdfName(child, key: "AS"), ["Off", onState].contains(appearance),
              rootStates.insert(onState).inserted
        else { return false }
    }
    guard rootStates == expectedStates else { return false }
    let expected = Set(snapshot.members.map { "\($0.page)|\($0.annotationIndex)|\($0.onState)" })
    var actual = Set<String>(); var selected = 0
    for pageNumber in 1...document.pageCount {
        guard let pageDictionary = documentRef.page(at: pageNumber)?.dictionary else { return false }
        var annotations: CGPDFArrayRef?
        guard CGPDFDictionaryGetArray(pageDictionary, "Annots", &annotations), let annotations else { continue }
        for index in 0..<CGPDFArrayGetCount(annotations) {
            var widget: CGPDFDictionaryRef?; var parent: CGPDFObjectRef?; var flags: CGPDFInteger = 0
            guard CGPDFArrayGetDictionary(annotations, index, &widget), let widget,
                  CGPDFDictionaryGetObject(widget, "Parent", &parent), parent == rootObject
            else { continue }
            guard CGPDFDictionaryGetInteger(widget, "Ff", &flags), Int(flags) == snapshot.flags,
                  let onState = radioNormalAppearanceState(widget), let appearance = pdfName(widget, key: "AS"), ["Off", onState].contains(appearance),
                  expected.contains("\(pageNumber)|\(index)|\(onState)")
            else { return false }
            if appearance == onState { selected += 1 }
            actual.insert("\(pageNumber)|\(index)|\(onState)")
        }
    }
    guard actual == expected, selected == 1 else { return false }
    for (affectedPage, initialHash) in snapshot.renderSHA256 { guard let hash = targetedRenderSHA256(document, page: affectedPage), hash != initialHash else { return false } }
    for member in snapshot.members {
        guard let memberPage = document.page(at: member.page - 1), member.annotationIndex < memberPage.annotations.count,
              memberPage.annotations[member.annotationIndex].buttonWidgetState.rawValue == (member.onState == targetOnState ? 1 : 0),
              memberPage.annotations[member.annotationIndex].buttonWidgetStateString == member.onState
        else { return false }
    }
    return true
}
