"""
Optimize thresholds for better recall while maintaining precision.
Tests different threshold combinations on report.csv.
"""
import asyncio
import csv
from pathlib import Path
from app.pipeline import pipeline
from app.config import settings


async def test_threshold_combinations():
    csv_path = Path(__file__).parent.parent.parent / "report.csv"
    
    if not csv_path.exists():
        print(f"report.csv not found at {csv_path}")
        return
    
    # Load test data
    data = []
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader):
            if i >= 500:  # Limit for faster testing
                break
            
            message = row.get('Message Content', '').strip()
            if not message:
                continue
            
            is_spam = row.get('Is Spam', '').strip()
            if is_spam not in ['0', '1']:
                continue
            
            data.append({
                'text': message,
                'expected': int(is_spam) == 1
            })
    
    print(f"Loaded {len(data)} test cases\n")
    
    # Test different threshold combinations
    test_cases = [
        {"rules": 0.5, "ml": 0.6},
        {"rules": 0.6, "ml": 0.7},
        {"rules": 0.65, "ml": 0.75},
        {"rules": 0.7, "ml": 0.8},  # Current default
        {"rules": 0.75, "ml": 0.85},
    ]
    
    best_f1 = 0
    best_config = None
    
    for test_case in test_cases:
        rules_threshold = test_case["rules"]
        ml_threshold = test_case["ml"]
        
        # Temporarily set thresholds
        original_rules = settings.rules_threshold
        original_ml = settings.ml_threshold
        settings.rules_threshold = rules_threshold
        settings.ml_threshold = ml_threshold
        
        print(f"Testing: rules={rules_threshold}, ml={ml_threshold}")
        
        total = 0
        correct = 0
        true_positives = 0
        false_positives = 0
        true_negatives = 0
        false_negatives = 0
        
        for item in data:
            result = await pipeline.classify(item['text'])
            predicted = result['spam_score'] >= 0.5
            expected = item['expected']
            
            total += 1
            
            if predicted == expected:
                correct += 1
                if predicted:
                    true_positives += 1
                else:
                    true_negatives += 1
            else:
                if predicted:
                    false_positives += 1
                else:
                    false_negatives += 1
        
        accuracy = (correct / total) * 100 if total > 0 else 0
        precision = (true_positives / (true_positives + false_positives)) * 100 if (true_positives + false_positives) > 0 else 0
        recall = (true_positives / (true_positives + false_negatives)) * 100 if (true_positives + false_negatives) > 0 else 0
        f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
        
        print(f"  Accuracy: {accuracy:.2f}%, Precision: {precision:.2f}%, Recall: {recall:.2f}%, F1: {f1:.2f}%")
        print(f"  TP: {true_positives}, FP: {false_positives}, TN: {true_negatives}, FN: {false_negatives}\n")
        
        if f1 > best_f1:
            best_f1 = f1
            best_config = {
                "rules": rules_threshold,
                "ml": ml_threshold,
                "accuracy": accuracy,
                "precision": precision,
                "recall": recall,
                "f1": f1
            }
        
        # Restore original thresholds
        settings.rules_threshold = original_rules
        settings.ml_threshold = original_ml
    
    print("="*60)
    print("BEST CONFIGURATION:")
    print("="*60)
    if best_config:
        print(f"Rules threshold: {best_config['rules']}")
        print(f"ML threshold: {best_config['ml']}")
        print(f"Accuracy: {best_config['accuracy']:.2f}%")
        print(f"Precision: {best_config['precision']:.2f}%")
        print(f"Recall: {best_config['recall']:.2f}%")
        print(f"F1 Score: {best_config['f1']:.2f}%")
    print("="*60)


if __name__ == "__main__":
    asyncio.run(test_threshold_combinations())

