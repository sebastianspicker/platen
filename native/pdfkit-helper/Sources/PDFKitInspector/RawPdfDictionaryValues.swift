import Foundation
import CoreGraphics

func pdfName(_ dictionary: CGPDFDictionaryRef, key: String) -> String? {
    var rawName: UnsafePointer<CChar>?
    guard CGPDFDictionaryGetName(dictionary, key, &rawName), let rawName else { return nil }
    return String(cString: rawName)
}

func pdfTextString(_ dictionary: CGPDFDictionaryRef, key: String) -> String? {
    var rawString: CGPDFStringRef?
    guard CGPDFDictionaryGetString(dictionary, key, &rawString),
          let rawString,
          let value = CGPDFStringCopyTextString(rawString) as String?,
          isWithin(value.utf8.count, 1, maximumStringLength)
    else { return nil }
    return value
}

func pdfScalarValue(_ dictionary: CGPDFDictionaryRef, key: String) -> String? {
    if let name = pdfName(dictionary, key: key) { return "name:\(name)" }
    if let text = pdfTextString(dictionary, key: key) { return "text:\(text)" }
    return nil
}

func pdfIntegerOrZero(_ dictionary: CGPDFDictionaryRef, key: String) -> Int? {
    guard dictionaryContainsObject(dictionary, key: key) else { return 0 }
    var value: CGPDFInteger = 0
    guard CGPDFDictionaryGetInteger(dictionary, key, &value) else { return nil }
    return Int(value)
}
